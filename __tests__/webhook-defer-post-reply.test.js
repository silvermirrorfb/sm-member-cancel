// PR-1: post-reply work (STOP Klaviyo unsubscribe, outbound sheet write, incident
// email) must be deferred behind next/server `after()` so the member-facing reply
// returns without waiting on slow Klaviyo/Sheets I/O. The local Redis stop-set write
// stays synchronous and ordered first. Failures in deferred work log at error level.
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
const mockUnsubscribeKlaviyoSms = vi.fn();
const mockRemoveMemberByPhone = vi.fn();
const mockAddToStopSet = vi.fn();
const mockRemoveFromStopSet = vi.fn();
const mockLookupClientIdByPhoneFromIndex = vi.fn();
const mockNormalizePhoneForIndex = vi.fn();

const originalEnv = process.env;

// Capturing `after`: deferred callbacks are recorded, not run, so a test can prove
// the reply returns BEFORE the deferred work executes, then flush them explicitly.
let afterCallbacks = [];
async function flushAfter() {
  const cbs = afterCallbacks;
  afterCallbacks = [];
  for (const cb of cbs) await cb();
}

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, after: (cb) => { afterCallbacks.push(cb); } };
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
vi.mock('../src/lib/klaviyo.js', () => ({
  unsubscribeKlaviyoSms: (...a) => mockUnsubscribeKlaviyoSms(...a),
}));
vi.mock('../src/lib/sms-member-registry.js', () => ({
  removeMemberByPhone: (...a) => mockRemoveMemberByPhone(...a),
  addToStopSet: (...a) => mockAddToStopSet(...a),
  removeFromStopSet: (...a) => mockRemoveFromStopSet(...a),
  lookupClientIdByPhoneFromIndex: (...a) => mockLookupClientIdByPhoneFromIndex(...a),
  normalizePhoneForIndex: (...a) => mockNormalizePhoneForIndex(...a),
}));

import { POST } from '../src/app/api/sms/twilio/webhook/route.js';

function makeReq(body) {
  return new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
    method: 'POST',
    headers: { 'x-twilio-signature': 'sig' },
    body,
  });
}

describe('webhook defers post-reply work behind after()', () => {
  beforeEach(() => {
    afterCallbacks = [];
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
    mockPostChatMessage.mockResolvedValue(new Response(JSON.stringify({ message: 'chat' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    mockLookupMember.mockResolvedValue(null);
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'none' });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'no_longer_available' });
    mockLogSupportIncident.mockResolvedValue({ sheet: { logged: true } });
    mockNotifyUpgradeIncidentOnce.mockResolvedValue({ sent: true });
    mockLogSmsChatMessages.mockResolvedValue({ logged: true, count: 1 });
    mockUnsubscribeKlaviyoSms.mockResolvedValue({ ok: true });
    mockRemoveMemberByPhone.mockResolvedValue(true);
    mockAddToStopSet.mockResolvedValue(true);
    mockRemoveFromStopSet.mockResolvedValue(true);
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue(null);
    mockNormalizePhoneForIndex.mockImplementation(v => String(v || ''));
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'Yes', MessageSid: 'SM-1' });
  });
  afterEach(() => { process.env = originalEnv; });

  it('STOP writes the Redis stop-set synchronously first and defers the Klaviyo unsubscribe', async () => {
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'STOP', MessageSid: 'SM-stop-1' });

    const res = await POST(makeReq('From=%2B12134401333&Body=STOP&MessageSid=SM-stop-1'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('unsubscribed');
    // Authoritative local opt-out is synchronous and happens before the deferred work runs.
    expect(mockAddToStopSet).toHaveBeenCalledTimes(1);
    expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
    // Klaviyo unsubscribe is deferred (NOT awaited inline on the reply path).
    expect(mockUnsubscribeKlaviyoSms).not.toHaveBeenCalled();
    expect(afterCallbacks.length).toBeGreaterThan(0);

    await flushAfter();
    expect(mockUnsubscribeKlaviyoSms).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribeKlaviyoSms).toHaveBeenCalledWith({ phone: '+12134401333' });
  });

  it('a verified-upgrade YES returns the reply before the outbound sheet write resolves', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-1', targetDurationMinutes: 50, currentDurationMinutes: 30,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

    const res = await POST(makeReq('From=%2B12134401333&Body=Yes&MessageSid=SM-verify-ok'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("You're all set. See you soon.");
    // The OUTBOUND confirmation row is deferred: not written inline before the reply.
    const outboundBefore = mockLogSmsChatMessages.mock.calls.flatMap(c => c[0]).filter(r => r && r.direction === 'outbound');
    expect(outboundBefore).toHaveLength(0);
    expect(afterCallbacks.length).toBeGreaterThan(0);

    await flushAfter();
    const outboundAfter = mockLogSmsChatMessages.mock.calls.flatMap(c => c[0]).filter(r => r && r.direction === 'outbound');
    expect(outboundAfter).toHaveLength(1);
    expect(outboundAfter[0]).toMatchObject({ direction: 'outbound', outcome: 'upgrade_confirmed' });
  });

  it('defers the support incident (sheet + email) rather than firing it inline', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-2', targetDurationMinutes: 50, currentDurationMinutes: 30,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_verification_failed', reverified: true });

    const res = await POST(makeReq('From=%2B12134401333&Body=Yes&MessageSid=SM-verify-fail'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('Our team will confirm before your appointment.');
    // Incident sheet + email are deferred, not fired inline.
    expect(mockLogSupportIncident).not.toHaveBeenCalled();
    expect(mockNotifyUpgradeIncidentOnce).not.toHaveBeenCalled();
    expect(afterCallbacks.length).toBeGreaterThan(0);

    await flushAfter();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockNotifyUpgradeIncidentOnce).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow incident sheet write block the incident email (concurrent, not serialized)', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-9', targetDurationMinutes: 50, currentDurationMinutes: 30,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_verification_failed', reverified: true });
    // The incident sheet write hangs; the human-alert email must still be sent.
    mockLogSupportIncident.mockReturnValue(new Promise(() => {}));

    const res = await POST(makeReq('From=%2B12134401333&Body=Yes&MessageSid=SM-hang'));
    expect(res.status).toBe(200);
    expect(afterCallbacks.length).toBeGreaterThan(0);

    // Start the deferred work but do NOT await it to completion (sheet hangs by design).
    afterCallbacks.forEach(cb => { cb(); });
    await Promise.resolve();
    await Promise.resolve();

    // Email started despite the hung sheet write: the two are concurrent, not serialized.
    expect(mockNotifyUpgradeIncidentOnce).toHaveBeenCalledTimes(1);
  });

  it('a thrown deferred task logs at error level and does not affect the reply already sent', async () => {
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'STOP', MessageSid: 'SM-stop-2' });
    mockUnsubscribeKlaviyoSms.mockRejectedValue(new Error('klaviyo down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeReq('From=%2B12134401333&Body=STOP&MessageSid=SM-stop-2'));
    const text = await res.text();

    // Reply is sent and correct regardless of the deferred failure.
    expect(res.status).toBe(200);
    expect(text).toContain('unsubscribed');
    expect(errSpy).not.toHaveBeenCalled(); // nothing failed yet; deferred work has not run

    await flushAfter();
    expect(errSpy).toHaveBeenCalled();
    const loggedError = errSpy.mock.calls.some(c => String(c.join(' ')).toLowerCase().includes('klaviyo'));
    expect(loggedError).toBe(true);
    errSpy.mockRestore();
  });
});
