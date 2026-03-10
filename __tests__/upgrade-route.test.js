import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionStore = new Map();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockReverifyAndApplyUpgradeForProfile = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('../src/lib/sessions.js', () => ({
  getSession: (id) => sessionStore.get(id) || null,
  addMessage: (id, role, content) => {
    const session = sessionStore.get(id);
    if (!session) return null;
    session.messages.push({ role, content });
    return session;
  },
  createSession: () => null,
}));

vi.mock('../src/lib/claude.js', () => ({
  getSystemPrompt: () => 'SYSTEM_PROMPT',
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
  logChatMessage: vi.fn(async () => ({ logged: true })),
  logSupportIncident: vi.fn(async () => ({ logged: true })),
}));

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
  getClientIP: () => '127.0.0.1',
}));

import { POST } from '../src/app/api/chat/message/route.js';

function createSession(overrides = {}) {
  return {
    id: 'sess-1',
    memberId: null,
    memberProfile: { clientId: 'client-1', tier: '30', accountStatus: 'active' },
    mode: 'membership',
    messages: [],
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

  it('YES inside active window re-verifies and confirms upgrade', async () => {
    const session = createSession({
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
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
    expect(body.message).toContain('confirmed the upgrade');
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
});
