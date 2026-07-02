import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockAddMessage = vi.fn();
const mockCreateSession = vi.fn();
const mockUpdateActivity = vi.fn();
const mockSaveSession = vi.fn();
const mockGetClientIP = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();
const mockGetSystemPrompt = vi.fn();
const mockSendMessage = vi.fn();
const mockLogChatMessages = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockResolveUpgradePrice = vi.fn();
const originalEnv = process.env;

vi.mock('../src/lib/sessions.js', () => ({
  getSession: (...args) => mockGetSession(...args),
  addMessage: (...args) => mockAddMessage(...args),
  createSession: (...args) => mockCreateSession(...args),
  updateActivity: (...args) => mockUpdateActivity(...args),
  saveSession: (...args) => mockSaveSession(...args),
}));

vi.mock('../src/lib/rate-limit.js', () => ({
  getClientIP: (...args) => mockGetClientIP(...args),
  resolveClientRateLimitKey: (...args) => mockGetClientIP(...args),
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  buildRateLimitHeaders: (...args) => mockBuildRateLimitHeaders(...args),
}));

vi.mock('../src/lib/claude.js', () => ({
  getSystemPrompt: (...args) => mockGetSystemPrompt(...args),
  getSystemPromptForSession: (session) =>
    session?.systemPrompt || mockGetSystemPrompt(),
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
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
  reverifyAndApplyUpgradeForProfile: vi.fn(),
}));

vi.mock('../src/lib/upgrade-pricing.js', () => ({
  resolveUpgradePrice: (...args) => mockResolveUpgradePrice(...args),
}));

vi.mock('../src/lib/notify.js', () => ({
  logChatMessages: (...args) => mockLogChatMessages(...args),
  logSupportIncident: vi.fn(),
}));

vi.mock('../src/lib/sms-sessions.js', () => ({
  markUpgradeOfferEvent: vi.fn(),
}));

import { POST, isBookingPaymentIncident } from '../src/app/api/chat/message/route.js';

describe('isBookingPaymentIncident', () => {
  it('detects real booking issues', () => {
    expect(isBookingPaymentIncident('booking page is frozen')).toBe(true);
    expect(isBookingPaymentIncident('checkout error with credit card')).toBe(true);
    expect(isBookingPaymentIncident('calendar not loading')).toBe(true);
    expect(isBookingPaymentIncident('payment failed at checkout')).toBe(true);
  });

  it('does not trigger for membership intent with overlapping words', () => {
    expect(
      isBookingPaymentIncident(
        "I need to pause my membership, wont be returning until July, resume billing in July",
      ),
    ).toBe(false);
    expect(isBookingPaymentIncident('I want to cancel my membership, billing issue')).toBe(false);
    expect(isBookingPaymentIncident("my member credits won't load")).toBe(false);
    expect(isBookingPaymentIncident("hold my membership, can't make appointments")).toBe(false);
  });

  it('still triggers for actual booking issues', () => {
    expect(isBookingPaymentIncident('the booking widget is broken')).toBe(true);
    expect(isBookingPaymentIncident('zip code error at checkout')).toBe(true);
  });
});

describe('chat message route rate-limit headers', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, SMS_UPGRADE_STATUS: 'live' };
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
    mockGetSystemPrompt.mockReturnValue('Base system prompt.');
    mockSaveSession.mockImplementation(async (session) => session);
    mockLogChatMessages.mockResolvedValue({ logged: true, count: 3 });
    mockGetSession.mockReturnValue(null);
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'none' });
    mockResolveUpgradePrice.mockReturnValue({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = originalEnv;
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

  it('returns pending upgrade copy for sms upgrade interest while the feature is on hold', async () => {
    process.env = { ...originalEnv, SMS_UPGRADE_STATUS: 'pending' };
    const session = {
      id: 'sess-sms-upgrade',
      createdAt: '2026-03-18T00:00:00.000Z',
      status: 'active',
      messages: [],
      memberProfile: {
        clientId: 'client-1',
        phone: '+12134401333',
        tier: '30',
      },
      mode: 'membership',
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
      pendingUpgradeOffer: null,
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

    const req = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-sms-upgrade',
        message: 'Can I upgrade to 50 minutes?',
        channel: 'sms',
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toContain('upgrade-by-text feature is still pending');
    expect(body.message).toContain('(888) 677-0055');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('returns pending upgrade copy for sms upgrade interest even before member lookup', async () => {
    process.env = { ...originalEnv, SMS_UPGRADE_STATUS: 'pending' };
    const session = {
      id: 'sess-sms-upgrade-guest',
      createdAt: '2026-03-18T00:00:00.000Z',
      status: 'active',
      messages: [],
      memberProfile: null,
      mode: null,
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
      pendingUpgradeOffer: null,
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

    const req = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-sms-upgrade-guest',
        message: 'Can I upgrade my appointment by text?',
        channel: 'sms',
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toContain('upgrade-by-text feature is still pending');
    expect(body.message).toContain('(888) 677-0055');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('adds sms response guidance to the Claude system prompt for sms requests', async () => {
    const session = {
      id: 'sess-sms-guidance',
      createdAt: '2026-03-18T00:00:00.000Z',
      status: 'active',
      messages: [],
      memberProfile: null,
      mode: null,
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
      pendingUpgradeOffer: null,
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
    mockSendMessage.mockResolvedValue('SMS-safe reply');

    const req = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-sms-guidance',
        message: 'What are your hours?',
        channel: 'sms',
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe('SMS-safe reply');
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('SMS CHANNEL RULES: You are responding via text message. Keep responses under 280 characters.'),
      session.messages,
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.not.stringContaining('[SMS channel'),
      session.messages,
    );
  });

  it('does not create a 90-minute upgrade offer in sms chat flow', async () => {
    const session = {
      id: 'sess-sms-90-blocked',
      createdAt: '2026-03-18T00:00:00.000Z',
      status: 'active',
      messages: [],
      memberProfile: {
        clientId: 'client-1',
        phone: '+12134401333',
        tier: '50',
        firstName: 'Matt',
      },
      mode: 'membership',
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
      pendingUpgradeOffer: null,
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
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-90',
      currentDurationMinutes: 50,
      targetDurationMinutes: 90,
      pricing: { walkinDelta: 110 },
    });
    mockSendMessage.mockResolvedValue('We can help with changes by phone if needed.');

    const req = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-sms-90-blocked',
        message: 'Can I upgrade to 90 minutes?',
        channel: 'sms',
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe('We can help with changes by phone if needed.');
    expect(body.pendingUpgradeOffer).toBeUndefined();
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  function upgradeSession(id) {
    return {
      id,
      createdAt: '2026-03-18T00:00:00.000Z',
      status: 'active',
      messages: [],
      memberProfile: { clientId: 'client-1', phone: '+12134401333', tier: '30', accountStatus: 'ACTIVE', firstName: 'Matt' },
      mode: 'membership',
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
      pendingUpgradeOffer: null,
    };
  }

  function upgradeRequest(id) {
    return new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id, message: 'Can I upgrade to 50 minutes?', channel: 'sms' }),
    });
  }

  it('quotes the member tier-aware delta and the SMS offer copy for an eligible chat upgrade', async () => {
    const session = upgradeSession('sess-up-member');
    mockGetSession.mockReturnValue(session);
    mockAddMessage.mockImplementation((sid, role, content) => { session.messages.push({ role, content }); return session; });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50,
      isMember: true, pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockResolveUpgradePrice.mockReturnValue({ deltaDollars: 40, totalDollars: 139, isMember: true });

    const res = await POST(upgradeRequest('sess-up-member'));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Identical to the SMS pre-appointment offer copy, with the member delta.
    expect(body.message).toBe("Hi Matt, good news: we can extend today's facial to 50 minutes for $40 more. Want to add it? Reply YES or NO.");
    expect(body.pendingUpgradeOffer).toBe(true);
    expect(session.pendingUpgradeOffer.deltaDollars).toBe(40);
    expect(session.pendingUpgradeOffer.totalDollars).toBe(139);
    expect(session.pendingUpgradeOffer.isMember).toBe(true);
  });

  it('quotes the flat non-member delta for an eligible chat upgrade', async () => {
    const session = upgradeSession('sess-up-nonmember');
    mockGetSession.mockReturnValue(session);
    mockAddMessage.mockImplementation((sid, role, content) => { session.messages.push({ role, content }); return session; });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-2', currentDurationMinutes: 30, targetDurationMinutes: 50,
      isMember: false, pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockResolveUpgradePrice.mockReturnValue({ deltaDollars: 50, totalDollars: 169, isMember: false });

    const res = await POST(upgradeRequest('sess-up-nonmember'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe("Hi Matt, good news: we can extend today's facial to 50 minutes for $50 more. Want to add it? Reply YES or NO.");
    expect(session.pendingUpgradeOffer.deltaDollars).toBe(50);
    expect(session.pendingUpgradeOffer.isMember).toBe(false);
  });

  it('does not make a chat upgrade offer when the price cannot be resolved (fail closed)', async () => {
    const session = upgradeSession('sess-up-unresolved');
    mockGetSession.mockReturnValue(session);
    mockAddMessage.mockImplementation((sid, role, content) => { session.messages.push({ role, content }); return session; });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-3', currentDurationMinutes: 30, targetDurationMinutes: 50,
      isMember: true, pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockResolveUpgradePrice.mockReturnValue(null); // e.g. active member with no resolvable rate
    mockSendMessage.mockResolvedValue('Happy to help with that.');

    const res = await POST(upgradeRequest('sess-up-unresolved'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pendingUpgradeOffer).toBeUndefined();
    expect(session.pendingUpgradeOffer).toBeNull();
  });
});
