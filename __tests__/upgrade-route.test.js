import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionStore = new Map();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockReverifyAndApplyUpgradeForProfile = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('../src/lib/sessions.js', () => ({
  getSession: (id) => sessionStore.get(id) || null,
  updateActivity: (id) => {
    const session = sessionStore.get(id);
    if (session) {
      session.lastActivity = new Date();
    }
    return session || null;
  },
  addMessage: (id, role, content) => {
    const session = sessionStore.get(id);
    if (!session) return null;
    session.messages.push({ role, content });
    if (role === 'assistant' || role === 'bot') {
      session.lastAssistantVisibleMessage = content;
      session.lastAssistantAt = new Date();
    }
    return session;
  },
  createSession: () => null,
  saveSession: async (session) => session,
}));

vi.mock('../src/lib/claude.js', () => ({
  getSystemPrompt: () => 'SYSTEM_PROMPT',
  getSystemPromptForSession: (session) => session?.systemPrompt || 'SYSTEM_PROMPT',
  buildSystemPromptWithProfile: () => 'MEMBER_PROMPT',
  sendMessage: (...args) => mockSendMessage(...args),
  parseMemberLookup: () => null,
  parseSessionSummary: () => null,
  stripAllSystemTags: (text) => String(text || ''),
}));

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: vi.fn(),
  formatProfileForPrompt: vi.fn(() => 'PROFILE'),
  verifyMemberIdentity: vi.fn(() => true),
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
  reverifyAndApplyUpgradeForProfile: (...args) => mockReverifyAndApplyUpgradeForProfile(...args),
}));

vi.mock('../src/lib/notify.js', () => ({
  logChatMessages: vi.fn(async () => ({ logged: true })),
  logSupportIncident: vi.fn(async () => ({ logged: true })),
}));

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterMs: 0, limit: 30, remaining: 29, backend: 'memory' }),
  getClientIP: () => '127.0.0.1',
  buildRateLimitHeaders: () => ({}),
}));

import { POST } from '../src/app/api/chat/message/route.js';

function createSession(overrides = {}) {
  return {
    id: 'sess-1',
    memberId: null,
    memberProfile: { clientId: 'client-1', tier: '30', accountStatus: 'active' },
    mode: 'membership',
    messages: [],
    lastProcessedUserFingerprint: null,
    lastProcessedUserAt: null,
    lastAssistantVisibleMessage: null,
    lastAssistantAt: null,
    createdAt: new Date('2026-03-09T00:00:00.000Z'),
    lastActivity: new Date('2026-03-09T00:00:00.000Z'),
    status: 'active',
    ...overrides,
  };
}

function makeRequest(message) {
  return new Request('http://localhost/api/chat/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-1', message }),
  });
}

describe('upgrade route flows', () => {
  beforeEach(() => {
    sessionStore.clear();
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue('Base assistant response');
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'none' });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'none' });
  });

  it('explicit "upgrade me" request returns deterministic offer without LLM', async () => {
    const session = createSession();
    sessionStore.set('sess-1', session);
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      requiredExtraMinutes: 20,
      availableGapMinutes: 25,
      gapUnlimited: false,
      isMember: true,
      startOn: '2026-03-09T16:00:00.000Z',
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
    });

    const res = await POST(makeRequest('Can I upgrade to 50 minutes?'));
    const body = await res.json();

    expect(body.pendingUpgradeOffer).toBe(true);
    expect(body.message).toContain('Reply YES in');
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(session.pendingUpgradeOffer?.appointmentId).toBe('appt-1');
  });

  it('uses the correct 90-minute service name in chat upgrade offers', async () => {
    const session = createSession({
      memberProfile: { clientId: 'client-1', tier: '50', accountStatus: 'active' },
    });
    sessionStore.set('sess-1', session);
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-90',
      currentDurationMinutes: 50,
      targetDurationMinutes: 90,
      requiredExtraMinutes: 40,
      availableGapMinutes: 45,
      gapUnlimited: false,
      isMember: true,
      startOn: '2026-03-09T16:00:00.000Z',
      pricing: { memberTotal: 189, memberDelta: 60, walkinTotal: 279, walkinDelta: 110 },
    });

    const res = await POST(makeRequest('Can I upgrade to 90 minutes?'));
    const body = await res.json();

    expect(body.pendingUpgradeOffer).toBe(true);
    expect(body.message).toContain('90-Min Premier Contour');
    expect(body.message).toContain('$110 more');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('YES inside active window re-verifies and confirms upgrade', async () => {
    const session = createSession({
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        offerKind: 'duration',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        isMember: true,
        pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    });
    sessionStore.set('sess-1', session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: true,
      reason: 'applied',
      opportunity: {
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        startOn: '2026-03-09T16:00:00.000Z',
      },
      mutationRoot: 'updateAppointment',
    });

    const res = await POST(makeRequest('yes'));
    const body = await res.json();

    expect(body.upgradeHandled).toBe(true);
    expect(body.upgradeResult.success).toBe(true);
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(body.message).toContain("You're all set. See you soon.");
  });

  it('YES inside active window routes to human-finalization copy when mutation is disabled', async () => {
    const session = createSession({
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        offerKind: 'duration',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        isMember: true,
        pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    });
    sessionStore.set('sess-1', session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'upgrade_mutation_disabled',
      opportunity: {
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        startOn: '2026-03-09T16:00:00.000Z',
      },
    });

    const res = await POST(makeRequest('yes'));
    const body = await res.json();

    expect(body.upgradeHandled).toBe(true);
    expect(body.upgradeResult.success).toBe(false);
    expect(body.message).toContain('our team will confirm before your appointment');
    expect(session.pendingUpgradeOffer).toBeNull();
  });

  it('YES after expiry falls back to normal AI flow', async () => {
    const session = createSession({
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      },
    });
    sessionStore.set('sess-1', session);
    mockSendMessage.mockResolvedValue('Thanks — here are directions.');

    const res = await POST(makeRequest('yes'));
    const body = await res.json();

    expect(body.upgradeHandled).toBeUndefined();
    expect(body.message).toContain('directions');
    expect(session.pendingUpgradeOffer).toBeNull();
  });

  it('NO clears pending offer', async () => {
    const session = createSession({
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    });
    sessionStore.set('sess-1', session);

    const res = await POST(makeRequest('No thanks'));
    const body = await res.json();

    expect(body.upgradeHandled).toBe(true);
    expect(body.upgradeResult.reason).toBe('declined');
    expect(session.pendingUpgradeOffer).toBeNull();
  });

  it('ambiguous response stays in AI conversation flow', async () => {
    const session = createSession({
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    });
    sessionStore.set('sess-1', session);
    mockSendMessage.mockResolvedValue('It would be an additional $40 as a member.');

    const res = await POST(makeRequest('How much would that be?'));
    const body = await res.json();

    expect(body.upgradeHandled).toBeUndefined();
    expect(body.message).toContain('$40');
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('directions question appends proactive eligible-upgrade offer', async () => {
    const session = createSession();
    sessionStore.set('sess-1', session);
    mockSendMessage.mockResolvedValue('We are at 862 Lexington Ave.');
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      requiredExtraMinutes: 20,
      availableGapMinutes: 25,
      gapUnlimited: false,
      isMember: true,
      startOn: '2026-03-09T16:00:00.000Z',
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
    });

    const res = await POST(makeRequest('Can you send directions to the location?'));
    const body = await res.json();

    expect(body.message).toContain('862 Lexington Ave');
    expect(body.message).toContain('Reply YES in');
    expect(session.pendingUpgradeOffer?.appointmentId).toBe('appt-1');
  });

  it('dedupes an immediate retry and reuses the last assistant reply', async () => {
    const session = createSession();
    sessionStore.set('sess-1', session);
    mockSendMessage.mockResolvedValue('We are open 8am to 8pm.');

    const firstRes = await POST(makeRequest('What are your hours?'));
    const firstBody = await firstRes.json();
    const secondRes = await POST(makeRequest('What are your hours?'));
    const secondBody = await secondRes.json();

    expect(firstBody.message).toBe('We are open 8am to 8pm.');
    expect(secondBody.message).toBe('We are open 8am to 8pm.');
    expect(secondBody.deduped).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(session.messages.filter(msg => msg.role === 'user')).toHaveLength(1);
    expect(session.messages.filter(msg => msg.role === 'assistant')).toHaveLength(1);
  });

  it('strips repeated virtual-assistant intros from model responses', async () => {
    const session = createSession();
    sessionStore.set('sess-1', session);
    mockSendMessage.mockResolvedValue(
      "Hi, I'm Silver Mirror's virtual assistant. I can help with facials, products, and memberships.\nHow can I help today?\n\nWe are open 8am to 8pm."
    );

    const res = await POST(makeRequest('What are your hours?'));
    const body = await res.json();

    expect(body.message).toBe('We are open 8am to 8pm.');
  });
});
