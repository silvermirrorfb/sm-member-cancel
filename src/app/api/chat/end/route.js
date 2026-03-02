import { NextResponse } from 'next/server';
import { getSession, completeSession } from '../../../../lib/sessions';
import { sendMessage, parseSessionSummary, stripSummaryFromResponse } from '../../../../lib/claude';
import { processConversationEnd } from '../../../../lib/notify';

export async function POST(request) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required.' }, { status: 400 });
    }

    const session = getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
    }

    // For general conversations (no member identified), just close cleanly
    // DO NOT log to the cancellations sheet — that's only for membership conversations
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

      const response = await sendMessage(systemPrompt, promptForSummary);
      summary = parseSessionSummary(response);

      if (!summary) {
        // Fallback minimal summary
        summary = {
          date: new Date().toISOString(),
          client_name: session.memberProfile?.name || 'Unknown',
          email: session.memberProfile?.email || 'Unknown',
          phone: session.memberProfile?.phone || null,
          location: session.memberProfile?.location || 'Unknown',
          membership_tier: session.memberProfile?.tier || 'Unknown',
          monthly_rate: session.memberProfile?.monthlyRate || 0,
          tenure_months: session.memberProfile?.tenureMonths || 0,
          account_status: session.memberProfile?.accountStatus || 'unknown',
          loyalty_points: session.memberProfile?.loyaltyPoints || 0,
          loyalty_redeemable: null,
          walkin_savings: null,
          rate_lock_savings_annual: null,
          unused_credits: session.memberProfile?.unusedCredits || 0,
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
          action_required: 'Review transcript — session ended without resolution. Follow up with member.',
          cost_to_company: '$0',
          member_sentiment: 'unknown',
          sheet_month: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
          sheet_solution: 'Referred to team — incomplete session',
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
