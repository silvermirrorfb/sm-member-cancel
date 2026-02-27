import { NextResponse } from 'next/server';
import { lookupMember, formatProfileForPrompt } from '../../../../lib/boulevard';
import { createSession } from '../../../../lib/sessions';
import { buildSystemPromptWithProfile, sendMessage } from '../../../../lib/claude';

export async function POST(request) {
  try {
    const body = await request.json();
    const { name, contact } = body; // contact = email or phone

    if (!name || !contact) {
      return NextResponse.json(
        { error: 'Name and email or phone required.' },
        { status: 400 }
      );
    }

    // Look up member in Boulevard
    const profile = await lookupMember(name, contact);

    if (!profile) {
      return NextResponse.json({
        authenticated: false,
        message: "I'm not finding an active membership under that info. Is there another email or phone number that might be on file? You can also reach our team directly at memberships@silvermirror.com.",
      });
    }

    // Check account status gating
    const gatingMessage = checkAccountStatus(profile);
    if (gatingMessage) {
      return NextResponse.json({
        authenticated: true,
        gated: true,
        message: gatingMessage,
      });
    }

    // Create session
    const profileText = formatProfileForPrompt(profile);
    const systemPrompt = buildSystemPromptWithProfile(profileText);
    const session = createSession(profile.email, profile);

    // Store the system prompt on the session for reuse
    session.systemPrompt = systemPrompt;

    // Get Claude's opening message
    const openingMessages = [
      { role: 'user', content: `The member has just opened the cancellation chat. Their profile is loaded. Start the conversation by greeting them and confirming their identity. Do not ask for their name or email — you already have it.` }
    ];

    const response = await sendMessage(systemPrompt, openingMessages);

    // Store in session history (we store the synthetic first message + response)
    session.messages = [
      ...openingMessages,
      { role: 'assistant', content: response },
    ];

    return NextResponse.json({
      authenticated: true,
      gated: false,
      sessionId: session.id,
      message: response,
      member: {
        firstName: profile.firstName,
        location: profile.location,
        tier: profile.tier,
        tenureMonths: profile.tenureMonths,
      },
    });
  } catch (err) {
    console.error('Chat start error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again or contact memberships@silvermirror.com.' },
      { status: 500 }
    );
  }
}

function checkAccountStatus(profile) {
  const status = (profile.accountStatus || '').toLowerCase();

  if (status === 'paused' || status === 'on_hold') {
    return "Your membership is currently on pause. Before we can make any changes, the pause needs to run its full duration. If you'd still like to cancel after your pause ends, reach out to us then or contact our team at memberships@silvermirror.com.";
  }

  if (status === 'overdue' || status === 'past_due') {
    return "Before we can process any membership changes, there may be an outstanding balance that would need to be resolved first. Our team at memberships@silvermirror.com can help get that sorted, and then we can talk about next steps.";
  }

  if (status === 'pending_cancellation' || status === 'scheduled_cancel') {
    return "It looks like you may already have a cancellation in progress. Our team at memberships@silvermirror.com can confirm the status and your effective date.";
  }

  if (profile.paymentsProcessed < 1) {
    return "Since your membership is brand new, our team would need to handle this directly. Please reach out to memberships@silvermirror.com and they'll take care of you.";
  }

  return null; // No gating — proceed
}
