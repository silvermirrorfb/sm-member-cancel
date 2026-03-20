import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockAddMessage = vi.fn();
const mockCreateSession = vi.fn();
const mockUpdateActivity = vi.fn();
const mockGetClientIP = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();
const mockSendMessage = vi.fn();
const mockLogChatMessages = vi.fn();

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
  sendMessage: (...args) => mockSendMessage(...args),
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
  logChatMessages: (...args) => mockLogChatMessages(...args),
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
    mockLogChatMessages.mockResolvedValue({ logged: true, count: 3 });
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

  it('logs the first real conversation turn as a single transcript batch', async () => {
    const session = {
      id: 'sess-2',
      createdAt: '2026-03-18T00:00:00.000Z',
      status: 'active',
      messages: [],
      memberProfile: null,
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
    };

    mockGetSession.mockReturnValue(session);
    mockAddMessage.mockImplementation((sessionId, role, content) => {
      session.messages.push({ role, content });
      if (role === 'assistant') {
        session.lastAssistantVisibleMessage = content;
        session.lastAssistantAt = new Date('2026-03-18T00:00:01.000Z');
      }
      return session;
    });
    mockSendMessage.mockResolvedValue('Helpful assistant reply');

    const req = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-2',
        message: 'hello there',
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe('Helpful assistant reply');
    expect(session.chatTranscriptStarted).toBe(true);
    expect(mockLogChatMessages).toHaveBeenCalledTimes(1);
    expect(mockLogChatMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId: 'sess-2',
        sessionCreated: '2026-03-18T00:00:00.000Z',
        role: 'assistant',
        content: "Hi, I'm Silver Mirror's virtual assistant. I can help with facials, products, and memberships.\nHow can I help today?",
      }),
      expect.objectContaining({
        sessionId: 'sess-2',
        sessionCreated: '2026-03-18T00:00:00.000Z',
        role: 'user',
        content: 'hello there',
      }),
      expect.objectContaining({
        sessionId: 'sess-2',
        sessionCreated: '2026-03-18T00:00:00.000Z',
        role: 'assistant',
        content: 'Helpful assistant reply',
      }),
    ]);
  });
});
