// PR-2: (a) a non-YES/NO reply to a LIVE upgrade offer gets one canned escalation that
// routes the member to their location, instead of vanishing into the general chat bot.
// (b) the YES confirmation price is sourced from the SAME pricing the offer quoted, so it
// can never contradict the offer (no "$169 total, members get 20% off" vs an offer of "+$50").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckRateLimit = vi.fn();
const mockGetClientIP = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();
const mockCreateSession = vi.fn();
const mockGetAllActiveSessions = vi.fn();
const mockGetSession = vi.fn();
const mockSaveSession = vi.fn();
const mockBindPhoneToSession = vi.fn();
const mockGetSessionIdForPhone = vi.fn();
const mockGetReplyForMessageSid = vi.fn();
const mockStoreReplyForMessageSid = vi.fn();
const mockNormalizePhone = vi.fn();
const mockBuildTwimlMessage = vi.fn();
const mockIsValidTwilioSignature = vi.fn();
const mockParseTwilioFormBody = vi.fn();
const mockPostChatMessage = vi.fn();
const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockReverifyAndApplyUpgradeForProfile = vi.fn();
const mockGetClientById = vi.fn();
const mockLogSupportIncident = vi.fn();
const mockNotifyUpgradeIncidentOnce = vi.fn();
const mockLogSmsChatMessages = vi.fn();
const originalEnv = process.env;

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, after: (cb) => { cb(); } };
});
vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: (...a) => mockCheckRateLimit(...a),
  getClientIP: (...a) => mockGetClientIP(...a),
  buildRateLimitHeaders: (...a) => mockBuildRateLimitHeaders(...a),
}));
vi.mock('../src/lib/sessions.js', () => ({
  createSession: (...a) => mockCreateSession(...a),
  getAllActiveSessions: (...a) => mockGetAllActiveSessions(...a),
  getSession: (...a) => mockGetSession(...a),
  saveSession: (...a) => mockSaveSession(...a),
}));
vi.mock('../src/lib/sms-sessions.js', () => ({
  bindPhoneToSession: (...a) => mockBindPhoneToSession(...a),
  getSessionIdForPhone: (...a) => mockGetSessionIdForPhone(...a),
  getReplyForMessageSid: (...a) => mockGetReplyForMessageSid(...a),
  normalizePhone: (...a) => mockNormalizePhone(...a),
  storeReplyForMessageSid: (...a) => mockStoreReplyForMessageSid(...a),
  getSessionByPhone: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/lib/twilio.js', () => ({
  buildTwimlMessage: (...a) => mockBuildTwimlMessage(...a),
  isValidTwilioSignature: (...a) => mockIsValidTwilioSignature(...a),
  parseTwilioFormBody: (...a) => mockParseTwilioFormBody(...a),
}));
vi.mock('../src/app/api/chat/message/route.js', () => ({ POST: (...a) => mockPostChatMessage(...a) }));
vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: (...a) => mockLookupMember(...a),
  evaluateUpgradeOpportunityForProfile: (...a) => mockEvaluateUpgradeOpportunityForProfile(...a),
  reverifyAndApplyUpgradeForProfile: (...a) => mockReverifyAndApplyUpgradeForProfile(...a),
  getClientById: (...a) => mockGetClientById(...a),
}));
vi.mock('../src/lib/notify.js', () => ({
  logSupportIncident: (...a) => mockLogSupportIncident(...a),
  logSmsChatMessages: (...a) => mockLogSmsChatMessages(...a),
  notifyUpgradeIncidentOnce: (...a) => mockNotifyUpgradeIncidentOnce(...a),
  SMS_UPGRADE_INCIDENT_ISSUE_TYPE: 'sms_upgrade_manual_followup',
}));

import { POST } from '../src/app/api/sms/twilio/webhook/route.js';

function makeReq(body) {
  return new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
    method: 'POST', headers: { 'x-twilio-signature': 'sig' }, body,
  });
}
function liveDurationOffer(extra = {}) {
  return {
    offerKind: 'duration', appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50,
    pricing: { walkinDelta: 50, walkinTotal: 169 },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), ...extra,
  };
}

describe('PR-2 off-script routing + confirmation price reconciliation', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true', SMS_UPGRADE_STATUS: 'live' };
    vi.clearAllMocks();
    mockCheckRateLimit.mockReturnValue({ allowed: true, limit: 120, remaining: 119, backend: 'memory' });
    mockBuildRateLimitHeaders.mockReturnValue({ 'X-RateLimit-Limit': '120' });
    mockGetClientIP.mockReturnValue('127.0.0.1');
    mockGetAllActiveSessions.mockResolvedValue([]);
    mockSaveSession.mockImplementation(async (s) => s);
    mockGetReplyForMessageSid.mockReturnValue(null);
    mockIsValidTwilioSignature.mockReturnValue(true);
    mockNormalizePhone.mockImplementation(v => String(v || ''));
    mockBuildTwimlMessage.mockImplementation(t => `<Response><Message>${t}</Message></Response>`);
    mockPostChatMessage.mockResolvedValue(new Response(JSON.stringify({ message: 'Handled in chat' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    mockLookupMember.mockResolvedValue(null);
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'none' });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'no_longer_available' });
    mockLogSupportIncident.mockResolvedValue({ sheet: { logged: true } });
    mockNotifyUpgradeIncidentOnce.mockResolvedValue({ sent: true });
    mockLogSmsChatMessages.mockResolvedValue({ logged: true, count: 1 });
  });
  afterEach(() => { process.env = originalEnv; });

  it('routes a non-YES/NO reply to a live upgrade offer to a canned location escalation, not the chat bot', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333', locationName: 'Flatiron' },
      pendingUpgradeOffer: liveDurationOffer({ isMember: false }),
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'can I use my credits for this?', MessageSid: 'SM-offscript' });

    const res = await POST(makeReq('From=%2B12134401333&Body=can+I+use+my+credits&MessageSid=SM-offscript'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('Flatiron');               // routed to the member's location
    expect(text).toContain('(888) 677-0055');          // a concrete contact, not a vanish
    expect(mockPostChatMessage).not.toHaveBeenCalled(); // did NOT fall into the general chat bot
    expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
  });

  it('falls through to chat (not the escalation) for an off-script reply when SMS upgrades are not live', async () => {
    process.env.SMS_UPGRADE_STATUS = 'pending';
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333', locationName: 'Flatiron' },
      pendingUpgradeOffer: liveDurationOffer({ isMember: false }),
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'can I use my credits?', MessageSid: 'SM-pending-offscript' });

    const res = await POST(makeReq('From=%2B12134401333&Body=can+I+use+my+credits&MessageSid=SM-pending-offscript'));
    const text = await res.text();

    expect(res.status).toBe(200);
    // SMS upgrades not live: the upgrade-context escalation must not fire; reply falls through to chat,
    // consistent with the YES path returning the feature-pending reply in this state.
    expect(mockPostChatMessage).toHaveBeenCalledTimes(1);
    expect(text).not.toContain('Flatiron');
  });

  it('keeps routing a non-YES/NO reply with no pending offer to the chat bot (scope guard)', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 2 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'What time is my appointment?', MessageSid: 'SM-chat' });

    const res = await POST(makeReq('From=%2B12134401333&Body=What+time&MessageSid=SM-chat'));
    const text = await res.text();

    expect(text).toContain('Handled in chat');
    expect(mockPostChatMessage).toHaveBeenCalledTimes(1);
  });

  it('confirmation echoes the offer price and drops the contradictory total + 20%-off line (non-member)', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: liveDurationOffer({ isMember: false }),
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_failed' });
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'Yes', MessageSid: 'SM-conf-nm' });

    const res = await POST(makeReq('From=%2B12134401333&Body=Yes&MessageSid=SM-conf-nm'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('$50');                      // echoes the offer's quoted delta
    expect(text).not.toContain('$169');                 // no contradicting total
    expect(text).not.toContain('20% off');              // no spurious discount claim
    expect(text).not.toContain("You're all set");       // apply did not succeed
    expect(text).toContain('Our team will confirm before your appointment.');
  });

  it('confirmation echoes the offer price for a member, with no contradiction', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      // Member fixture: pricing carries member + walk-in. The duration offer quotes the
      // walk-in delta to everyone, so the confirmation echoes that same $50, never $169/20%-off.
      pendingUpgradeOffer: liveDurationOffer({ isMember: true, pricing: { memberDelta: 40, memberTotal: 139, walkinDelta: 50, walkinTotal: 169 } }),
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_failed' });
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'Yes', MessageSid: 'SM-conf-m' });

    const res = await POST(makeReq('From=%2B12134401333&Body=Yes&MessageSid=SM-conf-m'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('$50');
    expect(text).not.toContain('$169');
    expect(text).not.toContain('20% off');
  });
});
