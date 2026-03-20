import { NextResponse } from 'next/server';
import { createSession } from '../../../../lib/sessions';
import { logChatWidgetOpen } from '../../../../lib/notify';
import { OPENING_MESSAGE } from '../../../../lib/chat-config';
import { buildRateLimitHeaders, checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

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

    try {
      await logChatWidgetOpen(session.id, sessionCreated, 'widget');
    } catch (err) {
      console.warn('Widget open log failed:', err);
    }

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
