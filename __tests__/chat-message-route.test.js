import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockAddMessage = vi.fn();
const mockCreateSession = vi.fn();
const mockUpdateActivity = vi.fn();
const mockGetClientIP = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();

vi.mock('../src/lib/sessions.js', () => ({
  getSession: (...args) => mockGetSession(...args),
  addMessage: (...args) => mockAddMessage(...args),
  createSession: (...args) => mockCreateSession(...args),
  updateActivity: (...args) => mockUpdateActivity(...args),
}));

vi.mock('../src/lib/rate-limit.js', () => ({
  getClientIP: (...args) => mockGetClientIP(...args),
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  buildRateLimitHeaders: (...args) => mockBuildRateLimitHeaders(...args),
}));

vi.mock('../src/lib/claude.js', () => ({
  getSystemPrompt: vi.fn(),
  buildSystemPromptWithProfile: vi.fn(),
  sendMessage: vi.fn(),
  parseMemberLookup: vi.fn(),
  parseSessionSummary: vi.fn(),
  stripAllSystemTags: (value) => String(value || ''),
}));

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: vi.fn(),
  formatProfileForPrompt: vi.fn(),
  verifyMemberIdentity: vi.fn(),
  evaluateUpgradeOpportunityForProfile: vi.fn(),
  reverifyAndApplyUpgradeForProfile: vi.fn(),
}));

vi.mock('../src/lib/notify.js', () => ({
  logChatMessage: vi.fn(),
  logSupportIncident: vi.fn(),
}));

vi.mock('../src/lib/sms-sessions.js', () => ({
  markUpgradeOfferEvent: vi.fn(),
}));

import { POST } from '../src/app/api/chat/message/route.js';

describe('chat message route rate-limit headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIP.mockReturnValue('203.0.113.21');
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      backend: 'upstash',
      retryAfterMs: 0,
      shadowMode: true,
      degraded: false,
      resetAt: 1773920400000,
    });
    mockBuildRateLimitHeaders.mockReturnValue({
      'X-RateLimit-Limit': '30',
      'X-RateLimit-Remaining': '29',
      'X-RateLimit-Backend': 'upstash',
    });
    mockGetSession.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns rate-limit headers on session-expired recovery failures', async () => {
    const req = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'missing-session-1',
        message: 'hello',
        history: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('Session expired');
    expect(res.headers.get('x-ratelimit-limit')).toBe('30');
    expect(res.headers.get('x-ratelimit-backend')).toBe('upstash');
  });
});
