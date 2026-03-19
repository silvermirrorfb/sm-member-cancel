import { NextResponse } from 'next/server';
import { createSession } from '../../../../lib/sessions';
import { logChatMessage } from '../../../../lib/notify';
import { buildRateLimitHeaders, checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

const OPENING_MESSAGE = `Hi, I'm Silver Mirror's virtual assistant. I can help with facials, products, and memberships.\nHow can I help today?`;

export async function POST(request) {
  try {
    // Rate limit: max 10 new sessions per 10 minutes per IP
    const ip = getClientIP(request);
    const rateLimit = await checkRateLimit(ip, 'start', 10, 10 * 60 * 1000);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a few minutes and try again.' },
        {
          status: 429,
          headers: buildRateLimitHeaders(rateLimit),
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
    }, {
      headers: buildRateLimitHeaders(rateLimit),
    });
  } catch (err) {
    console.error('Chat start error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}
