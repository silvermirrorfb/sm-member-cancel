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

    let summary = session.summary;

    // If we don't have a summary yet, ask Claude to generate one
    if (!summary) {
      const promptForSummary = [
        ...session.messages,
        {
          role: 'user',
          content: 'The conversation is ending. Please generate the session summary now, wrapped in <session_summary> tags as specified in your instructions.',
        },
      ];

      const response = await sendMessage(session.systemPrompt, promptForSummary);
      summary = parseSessionSummary(response);

      if (!summary) {
        // Fallback: build a minimal summary from what we know
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

    // Build transcript from message history
    const transcript = session.messages
      .map(m => {
        const label = m.role === 'user' ? 'MEMBER' : 'BOT';
        // Strip any system-level synthetic messages
        if (m.role === 'user' && m.content.startsWith('The member has just opened')) return null;
        if (m.role === 'user' && m.content.startsWith('The conversation is ending')) return null;
        return `[${label}]: ${stripSummaryFromResponse(m.content)}`;
      })
      .filter(Boolean)
      .join('\n\n');

    // Send notifications
    const notifyResult = await processConversationEnd(summary, transcript);

    // Mark session complete
    completeSession(sessionId, summary.outcome, summary);

    return NextResponse.json({
      completed: true,
      outcome: summary.outcome,
      notifications: notifyResult,
    });
  } catch (err) {
    console.error('Chat end error:', err);
    return NextResponse.json(
      { error: 'Error finalizing session. The membership team has been notified.' },
      { status: 500 }
    );
  }
}
