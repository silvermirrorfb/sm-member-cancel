import { NextResponse } from 'next/server';
import { createSession } from '../../../../lib/sessions';

const OPENING_MESSAGE = `Thanks for reaching out to Silver Mirror! I'm a virtual assistant trained to help with questions about facials, memberships, or our product line, Silver Mirror Skincare. If you have a time-sensitive need, please call us at (888) 677-0055.\n\nPlease note: all bookings must be done through the "Book A Facial" button at the top of silvermirror.com.\n\nHow can I help you today?`;

export async function POST(request) {
  try {
    // Create a new session — no auth required
    const session = createSession(null, null);

    return NextResponse.json({
      sessionId: session.id,
      message: OPENING_MESSAGE,
    });
  } catch (err) {
    console.error('Chat start error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}
