import { NextResponse } from 'next/server';
import { createSession } from '../../../../lib/sessions';
import { logChatMessage } from '../../../../lib/notify';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

const OPENING_MESSAGE = `Hi, I'm Silver Mirror's virtual assistant. I can help with facials, products, and memberships.\n\nFor urgent help, call (888) 677-0055. For bookings, please use the "Book A Facial" button at silvermirror.com.\n\nHow can I help today?`;

export async function POST(request) {
  try {
    // Rate limit: max 10 new sessions per 10 minutes per IP
    const ip = getClientIP(request);
    const { allowed, retryAfterMs } = checkRateLimit(ip, 'start', 10, 10 * 60 * 1000);

    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a few minutes and try again.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
        }
      );
    }

    // Create a new session — no auth required
    const session = createSession(null, null);
    const sessionCreated = new Date(session.createdAt).toISOString();

    // Log the greeting to the chatbot message log (fire-and-forget)
    logChatMessage(session.id, sessionCreated, 'assistant', OPENING_MESSAGE).catch(err =>
      console.warn('Chatlog failed for greeting:', err)
    );

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
