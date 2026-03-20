import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckRateLimit = vi.fn();
const mockGetClientIP = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();
const mockCreateSession = vi.fn();
const mockLogChatWidgetOpen = vi.fn();

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  getClientIP: (...args) => mockGetClientIP(...args),
  buildRateLimitHeaders: (...args) => mockBuildRateLimitHeaders(...args),
}));

vi.mock('../src/lib/sessions.js', () => ({
  createSession: (...args) => mockCreateSession(...args),
}));

vi.mock('../src/lib/notify.js', () => ({
  logChatWidgetOpen: (...args) => mockLogChatWidgetOpen(...args),
}));

import { POST } from '../src/app/api/chat/start/route.js';

describe('chat start route rate-limit headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIP.mockReturnValue('203.0.113.20');
    mockBuildRateLimitHeaders.mockImplementation(result => ({
      'X-RateLimit-Limit': String(result.limit || 10),
      'X-RateLimit-Remaining': String(result.remaining || 0),
      'X-RateLimit-Backend': result.backend || 'memory',
      ...(result.retryAfterMs ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : {}),
    }));
    mockCreateSession.mockReturnValue({
      id: 'sess-1',
      createdAt: '2026-03-18T00:00:00.000Z',
    });
    mockLogChatWidgetOpen.mockResolvedValue({ logged: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns rate-limit headers on success responses', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      backend: 'memory',
      retryAfterMs: 0,
    });

    const req = new Request('http://localhost/api/chat/start', { method: 'POST' });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessionId).toBe('sess-1');
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
    expect(mockLogChatWidgetOpen).toHaveBeenCalledWith(
      'sess-1',
      '2026-03-18T00:00:00.000Z',
      'widget'
    );
  });

  it('returns rate-limit headers on blocked responses', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      backend: 'upstash',
      retryAfterMs: 5000,
    });

    const req = new Request('http://localhost/api/chat/start', { method: 'POST' });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toContain('Too many requests');
    expect(res.headers.get('x-ratelimit-backend')).toBe('upstash');
    expect(res.headers.get('retry-after')).toBe('5');
  });
});
