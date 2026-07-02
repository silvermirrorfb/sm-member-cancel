import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// /api/chat/end is unauthenticated and its recovery path performs session-store
// writes for any caller-chosen sessionId. It had no rate limit at all. This adds
// the same per-client throttle the other chat routes use, and asserts a limited
// caller is rejected BEFORE any session work runs.

const mockGetClientIP = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();
const mockGetSession = vi.fn();
const mockCreateSession = vi.fn();
const mockAddMessage = vi.fn();
const mockCompleteSession = vi.fn();
const mockSaveSession = vi.fn();
const mockProcessConversationEnd = vi.fn();

vi.mock('../src/lib/rate-limit.js', () => ({
  getClientIP: (...args) => mockGetClientIP(...args),
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  buildRateLimitHeaders: (...args) => mockBuildRateLimitHeaders(...args),
}));

vi.mock('../src/lib/sessions.js', () => ({
  getSession: (...args) => mockGetSession(...args),
  createSession: (...args) => mockCreateSession(...args),
  addMessage: (...args) => mockAddMessage(...args),
  completeSession: (...args) => mockCompleteSession(...args),
  saveSession: (...args) => mockSaveSession(...args),
}));

vi.mock('../src/lib/claude.js', () => ({
  sendMessage: vi.fn(),
  parseSessionSummary: vi.fn(),
  stripSummaryFromResponse: (value) => String(value || ''),
}));

vi.mock('../src/lib/notify.js', () => ({
  processConversationEnd: (...args) => mockProcessConversationEnd(...args),
}));

import { POST } from '../src/app/api/chat/end/route.js';

function endRequest(body) {
  return new Request('http://localhost/api/chat/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat/end rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIP.mockReturnValue('203.0.113.30');
    mockBuildRateLimitHeaders.mockReturnValue({ 'X-RateLimit-Limit': '30', 'X-RateLimit-Remaining': '0' });
    mockCompleteSession.mockResolvedValue({});
    mockSaveSession.mockResolvedValue({});
    mockAddMessage.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with 429 and does no session work when the limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000, limit: 30, remaining: 0, backend: 'memory' });

    const res = await POST(endRequest({ sessionId: 'attacker-1', history: [{ role: 'user', content: 'x' }] }));

    expect(res.status).toBe(429);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockProcessConversationEnd).not.toHaveBeenCalled();
  });

  it('proceeds past the limiter when allowed (still validates sessionId)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0, limit: 30, remaining: 29, backend: 'memory' });

    const res = await POST(endRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('sessionId');
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });
});
