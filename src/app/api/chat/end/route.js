import { NextResponse } from 'next/server';
import { getSession, createSession, addMessage, completeSession, saveSession } from '../../../../lib/sessions';
import { sendMessage, parseSessionSummary, stripSummaryFromResponse } from '../../../../lib/claude';
import { processConversationEnd } from '../../../../lib/notify';
import { getClientIP, checkRateLimit, buildRateLimitHeaders } from '../../../../lib/rate-limit';

const MAX_RECOVERY_MESSAGES = 60;
const MAX_RECOVERY_MESSAGE_CHARS = 4000;

// cancel-bot #22: bot was hallucinating session_summary.date (e.g. emitting
// 2024-12-19 for a May 2026 session). Stamp the date server-side so the
// canonical cancellation record reflects the actual session timestamp.
function todayInEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function sanitizeRecoveredHistory(history) {
  if (!Array.isArray(history)) return [];

  const cleaned = [];
  for (const item of history.slice(-MAX_RECOVERY_MESSAGES)) {
    if (!item || typeof item !== 'object') continue;
    const roleRaw = String(item.role || '').toLowerCase();
    const role = roleRaw === 'bot' || roleRaw === 'assistant'
      ? 'assistant'
      : roleRaw === 'user'
      ? 'user'
      : null;
    if (!role) continue;
    if (typeof item.content !== 'string') continue;
    const content = item.content.trim().slice(0, MAX_RECOVERY_MESSAGE_CHARS);
    if (!content) continue;
    cleaned.push({ role, content });
  }
  return cleaned;
}

export async function POST(request) {
  try {
    // Rate limit before any session-store work: this route is unauthenticated
    // and its recovery path writes to the session store for any caller-chosen
    // sessionId. Fail-open (default) so a Redis blip never blocks a real close.
    const ip = getClientIP(request);
    const rateLimit = await checkRateLimit(ip, 'chat-end', 30, 10 * 60 * 1000);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment and try again.' },
        { status: 429, headers: buildRateLimitHeaders(rateLimit) },
      );
    }

    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required.' }, { status: 400 });
    }

    let session = await getSession(sessionId);

    const recoveredHistory = sanitizeRecoveredHistory(body.history);

    // P1-3: Recover session from client history on serverless rotation
    if (!session && recoveredHistory.length > 0) {
      console.warn(`End session ${sessionId} not found \u2014 recovering from client history`);
      session = await createSession(null, null, sessionId);
      for (const msg of recoveredHistory) {
        await addMessage(session.id, msg.role, msg.content);
      }
      // SECURITY (pen test 2026-07-01, VULN-1): recover the conversation history
      // ONLY. Never elevate to a membership session from body.memberProfile or
      // body.summary. Membership status is set exclusively by the server-side
      // Boulevard lookup during the live conversation; a recovered session with no
      // server-side member resolves to GENERAL below (no ops email, no sheet row).
    }

    if (!session) {
      // Graceful no-op close for expired sessions with no recoverable history.
      return NextResponse.json({
        completed: true,
        outcome: 'GENERAL',
        sessionMissing: true,
      });
    }

    // SECURITY (pen test 2026-07-01, VULN-1): do NOT accept body.memberProfile or
    // body.summary as a way to elevate an existing session to membership. Only the
    // server-side Boulevard lookup may set session.memberProfile; without it the
    // session finalizes as GENERAL below.
    await saveSession(session);

    // For general conversations (no member identified), just close cleanly
    // DO NOT log to the cancellations sheet \u2014 that's only for membership conversations
    if (!session.memberProfile) {
      await completeSession(sessionId, 'GENERAL', null);

      return NextResponse.json({
        completed: true,
        outcome: 'GENERAL',
      });
    }

    // For membership conversations, generate full summary
    let summary = session.summary;

    if (!summary) {
      const systemPrompt = session.systemPrompt;
      const promptForSummary = [
        ...session.messages,
        {
          role: 'user',
          content: 'The conversation is ending. Please generate the session summary now, wrapped in <session_summary> tags as specified in your instructions.',
        },
      ];

      // P2-1: Wrap Claude call in try/catch so email + sheet still get logged on failure
      try {
        const response = await sendMessage(systemPrompt, promptForSummary);
        summary = parseSessionSummary(response);
      } catch (err) {
        console.error('Claude summary generation failed \u2014 using fallback:', err.message);
      }

      if (!summary) {
        // Fallback minimal summary
        summary = {
          client_name: session.memberProfile?.name || 'Unknown',
          email: session.memberProfile?.email || 'Unknown',
          phone: session.memberProfile?.phone || null,
          location: session.memberProfile?.location || 'Unknown',
          membership_tier: session.memberProfile?.tier || 'Unknown',
          monthly_rate: Number.isFinite(session.memberProfile?.monthlyRate) ? session.memberProfile.monthlyRate : null,
          tenure_months: Number.isFinite(session.memberProfile?.tenureMonths) ? session.memberProfile.tenureMonths : null,
          account_status: session.memberProfile?.accountStatus || 'unknown',
          loyalty_points: Number.isFinite(session.memberProfile?.loyaltyPoints) ? session.memberProfile.loyaltyPoints : null,
          loyalty_redeemable: null,
          walkin_savings: null,
          rate_lock_savings_annual: null,
          unused_credits: Number.isFinite(session.memberProfile?.unusedCredits) ? session.memberProfile.unusedCredits : null,
          next_perk_month: null,
          next_perk_name: null,
          next_perk_value: null,
          perks_claimed: null,
          reason_primary: 'Session ended without clear reason',
          reason_secondary: null,
          reason_verbatim: 'Conversation incomplete or abandoned',
          outcome: 'INCOMPLETE',
          offer_accepted: null,
          commitment_disclosed: false,
          lead_recommended: null,
          offers_presented: [],
          all_declined: false,
          action_required: 'Review transcript \u2014 session ended without resolution. Follow up with member.',
          cost_to_company: '$0',
          member_sentiment: 'unknown',
          sheet_month: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
          sheet_solution: 'Incomplete session \u2014 review transcript and follow up',
        };
      }
    }

    // Build transcript (filter out [SYSTEM] messages)
    const transcript = session.messages
      .map(m => {
        if (m.role === 'user' && m.content.startsWith('[SYSTEM]')) return null;
        if (m.role === 'user' && m.content.startsWith('The conversation is ending')) return null;
        const label = m.role === 'user' ? 'MEMBER' : 'BOT';
        return `[${label}]: ${stripSummaryFromResponse(m.content)}`;
      })
      .filter(Boolean)
      .join('\n\n');

    // cancel-bot #22: stamp date server-side. Bot-generated dates are
    // unreliable (Zoe Dickinson 2026-05-07 logged as 2024-12-19; Sindhura
    // Polepalli 2026-05-10 logged as 2025-01-27). Overwrite anything the
    // bot returned in summary.date with the actual server-side date.
    summary.date = todayInEastern();

    // Send email + log to cancellations sheet
    const notifyResult = await processConversationEnd(summary, transcript);

    await completeSession(sessionId, summary.outcome, summary);

    return NextResponse.json({
      completed: true,
      outcome: summary.outcome,
      notifications: notifyResult,
    });
  } catch (err) {
    console.error('Chat end error:', err);
    return NextResponse.json(
      { error: 'Error finalizing session. Please call (888) 677-0055 if you need immediate help.' },
      { status: 500 }
    );
  }
}
