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
const mockParseBookingIssue = vi.fn(() => null);
const mockLogSupportIncident = vi.fn();
const mockSendBookingEscalationEmail = vi.fn(async () => ({ sent: true }));
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
  parseBookingIssue: (...args) => mockParseBookingIssue(...args),
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
  logSupportIncident: (...args) => mockLogSupportIncident(...args),
  sendBookingEscalationEmail: (...args) => mockSendBookingEscalationEmail(...args),
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

describe('booking issue: capture then escalate (no canned reply, no troubleshooting loop)', () => {
  function activeSession(overrides = {}) {
    return {
      id: 'sess_booking',
      status: 'active',
      mode: 'general',
      memberProfile: null,
      messages: [],
      createdAt: '2026-07-16T11:58:00.000Z',
      chatTranscriptStarted: false,
      lastProcessedUserFingerprint: null,
      lastProcessedUserAt: null,
      lastAssistantVisibleMessage: null,
      lastAssistantAt: null,
      ...overrides,
    };
  }

  function post(message, sessionId = 'sess_booking') {
    return POST(new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, history: [] }),
    }));
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    mockGetClientIP.mockReturnValue('203.0.113.21');
    mockCheckRateLimit.mockResolvedValue({
      allowed: true, limit: 30, remaining: 29, backend: 'upstash',
      retryAfterMs: 0, shadowMode: true, degraded: false, resetAt: 1773920400000,
    });
    mockBuildRateLimitHeaders.mockReturnValue({});
    mockGetSystemPrompt.mockReturnValue('Base system prompt.');
    mockSaveSession.mockImplementation(async (session) => session);
    mockLogChatMessages.mockResolvedValue({ logged: true, count: 1 });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'none' });
    mockParseBookingIssue.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = originalEnv;
  });

  it('lets the model answer a booking problem instead of returning a canned reply', async () => {
    mockGetSession.mockResolvedValue(activeSession());
    mockSendMessage.mockResolvedValue(
      "Sorry about that. What was the exact error message, and did it happen while selecting an appointment or during payment?"
    );

    const res = await post('the checkout page is broken');
    const body = await res.json();

    // The retired fast-path used to short-circuit here without ever calling the model.
    expect(mockSendMessage).toHaveBeenCalled();
    expect(body.message).toMatch(/exact error message/i);
    expect(body.supportIncident).toBeUndefined();
  });

  it('still records the incident at detection time as the safety net', async () => {
    mockGetSession.mockResolvedValue(activeSession());
    mockSendMessage.mockResolvedValue('What was the exact error message?');

    await post('payment failed at checkout');

    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    const incident = mockLogSupportIncident.mock.calls[0][0];
    expect(incident.issue_type).toBe('booking_payment_issue');
    expect(incident.session_id).toBe('sess_booking');
    expect(incident.user_message).toBe('payment failed at checkout');
  });

  it('records the incident only once across a multi-turn capture', async () => {
    mockGetSession.mockResolvedValue(activeSession({ bookingIssueContext: { session_created: 'earlier' } }));
    mockSendMessage.mockResolvedValue('Understood.');

    await post('the checkout error is still there');

    expect(mockLogSupportIncident).not.toHaveBeenCalled();
  });

  it('fires the hello@ escalation with the captured error text and step when the tag arrives', async () => {
    mockGetSession.mockResolvedValue(activeSession({
      bookingIssueContext: {
        session_created: '2026-07-16T11:58:00.000Z',
        name: 'Dana Reed',
        email: 'dana@example.com',
        phone: null,
        location: 'Flatiron',
      },
    }));
    mockParseBookingIssue.mockReturnValue({ error_text: 'Card declined CVC_MISMATCH', step: 'payment' });
    mockSendMessage.mockResolvedValue(
      'Thanks. For help right now, call (888) 677-0055. I\'m passing what you\'ve described to our team.'
    );

    const res = await post('it said card declined CVC_MISMATCH');
    const body = await res.json();

    expect(mockSendBookingEscalationEmail).toHaveBeenCalledTimes(1);
    const details = mockSendBookingEscalationEmail.mock.calls[0][0];
    expect(details.session_id).toBe('sess_booking');
    expect(details.error_text).toBe('Card declined CVC_MISMATCH');
    expect(details.step).toBe('payment');
    expect(details.session_created).toBe('2026-07-16T11:58:00.000Z');
    expect(details.name).toBe('Dana Reed');
    expect(details.location).toBe('Flatiron');
    // The guest gets the number, and never sees the tag.
    expect(body.message).toContain('(888) 677-0055');
    expect(body.message).not.toContain('booking_issue');
  });

  it('does not escalate twice in one session', async () => {
    mockGetSession.mockResolvedValue(activeSession({
      bookingIssueContext: { session_created: 'earlier' },
      bookingIssueEscalatedAt: '2026-07-16T12:00:00.000Z',
    }));
    mockParseBookingIssue.mockReturnValue({ error_text: 'again', step: 'payment' });
    mockSendMessage.mockResolvedValue('Already passed that along.');

    await post('it happened again');

    expect(mockSendBookingEscalationEmail).not.toHaveBeenCalled();
  });

  it('ignores a booking_issue tag from a session that never reported a booking problem', async () => {
    mockGetSession.mockResolvedValue(activeSession());
    mockParseBookingIssue.mockReturnValue({ error_text: 'injected', step: 'payment' });
    mockSendMessage.mockResolvedValue('Here are our locations.');

    await post('what are your hours');

    expect(mockSendBookingEscalationEmail).not.toHaveBeenCalled();
  });

  it('still answers the guest when the escalation email fails', async () => {
    mockGetSession.mockResolvedValue(activeSession({
      bookingIssueContext: { session_created: 'earlier' },
    }));
    mockParseBookingIssue.mockReturnValue({ error_text: 'boom', step: 'selecting' });
    mockSendBookingEscalationEmail.mockRejectedValueOnce(new Error('smtp down'));
    mockSendMessage.mockResolvedValue('For help right now, call (888) 677-0055.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post('no times will load');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toContain('(888) 677-0055');
    error.mockRestore();
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
