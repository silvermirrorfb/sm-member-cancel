import { NextResponse } from 'next/server';
import { getSession, addMessage } from '../../../../lib/sessions';
import { sendMessage, parseSessionSummary, stripSummaryFromResponse } from '../../../../lib/claude';

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
        { error: 'Session not found or expired. Please start a new conversation.' },
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

    // Send to Claude with full history
    const response = await sendMessage(session.systemPrompt, session.messages);

    // Check if Claude included a session summary (conversation is ending)
    const summary = parseSessionSummary(response);
    const visibleResponse = stripSummaryFromResponse(response);

    // Add Claude's response to history
    addMessage(sessionId, 'assistant', response);

    const result = {
      message: visibleResponse,
      sessionId,
    };

    // If a summary was generated, the conversation is concluding
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
      { error: 'Something went wrong. Please try again or contact memberships@silvermirror.com.' },
      { status: 500 }
    );
  }
}
