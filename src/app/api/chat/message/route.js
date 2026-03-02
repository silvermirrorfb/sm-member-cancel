import { NextResponse } from 'next/server';
import { getSession, addMessage } from '../../../../lib/sessions';
import {
  getSystemPrompt,
  buildSystemPromptWithProfile,
  sendMessage,
  parseMemberLookup,
  stripMemberLookup,
  parseSessionSummary,
  stripSummaryFromResponse,
  stripAllSystemTags,
} from '../../../../lib/claude';
import { lookupMember, formatProfileForPrompt } from '../../../../lib/boulevard';

export async function POST(request) {
  try {
    const body = await request.json();
    const { sessionId, message } = body;

    if (!sessionId || !message) {
      return NextResponse.json(
        { error: 'sessionId and message required.' },
        { status: 400 }
      );
    }

    const session = getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found or expired. Please refresh and start a new conversation.' },
        { status: 404 }
      );
    }

    if (session.status !== 'active') {
      return NextResponse.json(
        { error: 'This conversation has already ended.' },
        { status: 400 }
      );
    }

    // Add user message to history
    addMessage(sessionId, 'user', message);

    // Determine which system prompt to use
    const systemPrompt = session.systemPrompt || getSystemPrompt();

    // Send to Claude with full history
    let response = await sendMessage(systemPrompt, session.messages);

    // ── Check for member_lookup request ──
    const lookupRequest = parseMemberLookup(response);

    if (lookupRequest && !session.memberProfile) {
      // Claude wants to look up a member — strip the lookup tag for visible response
      const visibleAck = stripAllSystemTags(response);

      // Store Claude's acknowledgment in history (with tags stripped)
      addMessage(sessionId, 'assistant', visibleAck);

      // Attempt Boulevard lookup
      const contactValue = lookupRequest.email || lookupRequest.phone || '';
      const fullName = `${lookupRequest.firstName || ''} ${lookupRequest.lastName || ''}`.trim();

      let profile = null;
      try {
        profile = await lookupMember(fullName, contactValue);
      } catch (err) {
        console.error('Boulevard lookup error:', err);
      }

      if (profile) {
        // Success — switch to Membership Mode
        const profileText = formatProfileForPrompt(profile);
        const memberSystemPrompt = buildSystemPromptWithProfile(profileText);

        // Store on session
        session.systemPrompt = memberSystemPrompt;
        session.memberProfile = profile;
        session.mode = 'membership';

        // Send a system-level message to Claude so it knows the profile is loaded
        addMessage(sessionId, 'user', '[SYSTEM] Member profile has been loaded. You are now in Membership Mode. Greet the member by first name, confirm their details, and ask how you can help with their membership.');

        const memberResponse = await sendMessage(memberSystemPrompt, session.messages);
        const cleanMemberResponse = stripAllSystemTags(memberResponse);

        addMessage(sessionId, 'assistant', cleanMemberResponse);

        return NextResponse.json({
          // Return BOTH the acknowledgment and the member greeting
          message: visibleAck + '\n\n' + cleanMemberResponse,
          sessionId,
          memberIdentified: true,
        });
      } else {
        // Lookup failed — tell Claude via a system message
        addMessage(sessionId, 'user', '[SYSTEM] Member lookup failed — no matching account found. Let the customer know we could not find their account and suggest they try a different email/phone or contact memberships@silvermirror.com directly.');

        const failResponse = await sendMessage(systemPrompt, session.messages);
        const cleanFailResponse = stripAllSystemTags(failResponse);

        addMessage(sessionId, 'assistant', cleanFailResponse);

        return NextResponse.json({
          message: visibleAck + '\n\n' + cleanFailResponse,
          sessionId,
          memberIdentified: false,
        });
      }
    }

    // ── Normal response (no lookup) ──
    const summary = parseSessionSummary(response);
    const visibleResponse = stripAllSystemTags(response);

    addMessage(sessionId, 'assistant', response);

    const result = {
      message: visibleResponse,
      sessionId,
    };

    // If a session summary was generated, the membership conversation is ending
    if (summary) {
      result.conversationEnding = true;
      result.summary = summary;
      session.summary = summary;
      session.outcome = summary.outcome;
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('Chat message error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again or call (888) 677-0055.' },
      { status: 500 }
    );
  }
}
