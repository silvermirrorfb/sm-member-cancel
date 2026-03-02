import { NextResponse } from 'next/server';
import { getSession, createSession, addMessage, completeSession } from '../../../../lib/sessions';
import { sendMessage, parseSessionSummary, stripSummaryFromResponse } from '../../../../lib/claude';
import { processConversationEnd } from '../../../../lib/notify';

const MAX_RECOVERY_MESSAGES = 60;
const MAX_RECOVERY_MESSAGE_CHARS = 4000;

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
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required.' }, { status: 400 });
    }

    let session = getSession(sessionId);

    const recoveredHistory = sanitizeRecoveredHistory(body.history);

    // P1-3: Recover session from client history on serverless rotation
    if (!session && recoveredHistory.length > 0) {
      console.warn(`End session ${sessionId} not found \u2014 recovering from client history`);
      session = createSession(null, null, sessionId);
      for (const msg of recoveredHistory) {
        addMessage(session.id, msg.role, msg.content);
      }
      // Restore member profile if provided by client
      if (body.memberProfile) {
        session.memberProfile = body.memberProfile;
        session.mode = 'membership';
      }
      // Use client-provided summary if available (avoids redundant Claude call)
      if (body.summary) {
        session.summary = body.summary;
      }
    }

    if (!session) {
      // Graceful no-op close for expired sessions with no recoverable history.
      return NextResponse.json({
        completed: true,
        outcome: 'GENERAL',
        sessionMissing: true,
      });
    }

    // For general conversations (no member identified), just close cleanly
    // DO NOT log to the cancellations sheet \u2014 that's only for membership conversations
    if (!session.memberProfile) {
      completeSession(sessionId, 'GENERAL', null);

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
          date: new Date().toISOString(),
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
          outcome: 'REFERRED',
          offer_accepted: null,
          commitment_disclosed: false,
          lead_recommended: null,
          offers_presented: [],
          all_declined: false,
          action_required: 'Review transcript \u2014 session ended without resolution. Follow up with member.',
          cost_to_company: '$0',
          member_sentiment: 'unknown',
          sheet_month: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
          sheet_solution: 'Referred to team \u2014 incomplete session',
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

    // Send email + log to cancellations sheet
    const notifyResult = await processConversationEnd(summary, transcript);

    completeSession(sessionId, summary.outcome, summary);

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
