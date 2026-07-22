import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckRateLimit = vi.fn();
const mockGetClientIP = vi.fn();
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
const mockBuildRateLimitHeaders = vi.fn();
const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockReverifyAndApplyUpgradeForProfile = vi.fn();
const mockLogSupportIncident = vi.fn();
const mockNotifyUpgradeIncidentOnce = vi.fn();
const mockLogSmsChatMessages = vi.fn();
const mockSendTwilioSms = vi.fn();
const mockCheckStopSetStrict = vi.fn();
const mockAddToStopSet = vi.fn();
const mockRemoveMemberByPhone = vi.fn();
const mockClaimAppliedFollowupSend = vi.fn();
const mockCheckKlaviyoSmsOptIn = vi.fn();
const mockUnsubscribeKlaviyoSms = vi.fn();
const originalEnv = process.env;

// Ratified carve-out (2026-07-22): the applied-outcome follow-up is a
// transactional reply to the member's own YES and is exempt from the Klaviyo
// SUBSCRIBED marketing gate. Klaviyo is mocked so the suite can PROVE the
// webhook YES path never consults it; only the STOP handler's unsubscribe
// propagation may touch this module.
vi.mock('../src/lib/klaviyo.js', () => ({
  checkKlaviyoSmsOptIn: (...args) => mockCheckKlaviyoSmsOptIn(...args),
  unsubscribeKlaviyoSms: (...args) => mockUnsubscribeKlaviyoSms(...args),
}));

// Passthrough mock: the strict tri-state stop-set check (follow-up send gate)
// plus the inbound STOP handler's two writes (addToStopSet, removeMemberByPhone)
// are overridden so their ordering and failure isolation are testable; every
// other registry export (START uses removeFromStopSet via dynamic import) keeps
// its real no-Redis no-op behavior.
vi.mock('../src/lib/sms-member-registry.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkStopSetStrict: (...args) => mockCheckStopSetStrict(...args),
    addToStopSet: (...args) => mockAddToStopSet(...args),
    removeMemberByPhone: (...args) => mockRemoveMemberByPhone(...args),
    claimAppliedFollowupSend: (...args) => mockClaimAppliedFollowupSend(...args),
  };
});

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  getClientIP: (...args) => mockGetClientIP(...args),
  buildInternalRateLimitHeaders: (identifier) => ({ 'x-internal-ratelimit-id': String(identifier || '') }),
  buildRateLimitHeaders: (...args) => mockBuildRateLimitHeaders(...args),
}));

vi.mock('../src/lib/sessions.js', () => ({
  createSession: (...args) => mockCreateSession(...args),
  getAllActiveSessions: (...args) => mockGetAllActiveSessions(...args),
  getSession: (...args) => mockGetSession(...args),
  saveSession: (...args) => mockSaveSession(...args),
}));

vi.mock('../src/lib/sms-sessions.js', () => ({
  bindPhoneToSession: (...args) => mockBindPhoneToSession(...args),
  getSessionIdForPhone: (...args) => mockGetSessionIdForPhone(...args),
  getReplyForMessageSid: (...args) => mockGetReplyForMessageSid(...args),
  normalizePhone: (...args) => mockNormalizePhone(...args),
  storeReplyForMessageSid: (...args) => mockStoreReplyForMessageSid(...args),
}));

vi.mock('../src/lib/twilio.js', () => ({
  buildTwimlMessage: (...args) => mockBuildTwimlMessage(...args),
  isValidTwilioSignature: (...args) => mockIsValidTwilioSignature(...args),
  parseTwilioFormBody: (...args) => mockParseTwilioFormBody(...args),
  sendTwilioSms: (...args) => mockSendTwilioSms(...args),
  trimSmsBodyShort: (text) => text,
}));

vi.mock('../src/app/api/chat/message/route.js', () => ({
  POST: (...args) => mockPostChatMessage(...args),
}));

vi.mock('../src/lib/boulevard.js', async () => {
  // Keep the real error formatter so the incident-text assertion exercises the
  // production summarizer, while the network-touching apply fns stay mocked.
  const actual = await vi.importActual('../src/lib/boulevard.js');
  return {
    lookupMember: (...args) => mockLookupMember(...args),
    evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
    reverifyAndApplyUpgradeForProfile: (...args) => mockReverifyAndApplyUpgradeForProfile(...args),
    summarizeBoulevardApplyError: actual.summarizeBoulevardApplyError,
  };
});

vi.mock('../src/lib/notify.js', () => ({
  logSupportIncident: (...args) => mockLogSupportIncident(...args),
  logSmsChatMessages: (...args) => mockLogSmsChatMessages(...args),
  notifyUpgradeIncidentOnce: (...args) => mockNotifyUpgradeIncidentOnce(...args),
  SMS_UPGRADE_INCIDENT_ISSUE_TYPE: 'sms_upgrade_manual_followup',
}));

import { POST } from '../src/app/api/sms/twilio/webhook/route.js';

// PR-B: the YES/NO reply returns deterministic TwiML immediately and runs the
// Boulevard apply, incident, Sheets logging, and pending-offer clear in
// deferWork() (next/server after(), or a detached promise outside a request
// scope). Flush that detached work before asserting its side effects. A short
// macrotask drains the deferred promise chain (mocks resolve synchronously).
const flushDeferred = () => new Promise(resolve => setTimeout(resolve, 10));

describe('twilio webhook route', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      SMS_UPGRADE_STATUS: 'live',
    };
    vi.clearAllMocks();
    mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0, limit: 120, remaining: 119, backend: 'memory' });
    mockBuildRateLimitHeaders.mockReturnValue({
      'X-RateLimit-Limit': '120',
      'X-RateLimit-Remaining': '119',
      'X-RateLimit-Backend': 'memory',
    });
    mockGetAllActiveSessions.mockResolvedValue([]);
    mockGetClientIP.mockReturnValue('127.0.0.1');
    mockSaveSession.mockImplementation(async (session) => session);
    mockGetReplyForMessageSid.mockReturnValue(null);
    mockIsValidTwilioSignature.mockReturnValue(true);
    mockNormalizePhone.mockImplementation(value => String(value || ''));
    mockBuildTwimlMessage.mockImplementation(text => `<Response><Message>${text}</Message></Response>`);
    mockParseTwilioFormBody.mockReturnValue({
      From: '+12134401333',
      Body: 'Yes',
      MessageSid: 'SM-in-1',
    });
    mockPostChatMessage.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Handled in chat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mockLookupMember.mockResolvedValue(null);
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'no_upcoming_appointment_in_window' });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'no_longer_available' });
    mockLogSupportIncident.mockResolvedValue({
      email: { sent: true },
      sheet: { logged: true },
    });
    mockNotifyUpgradeIncidentOnce.mockReset().mockResolvedValue({ sent: true, deduped: false });
    mockLogSmsChatMessages.mockResolvedValue({ logged: true, count: 1 });
    mockSendTwilioSms.mockResolvedValue({ sid: 'SM-followup-1' });
    mockCheckStopSetStrict.mockResolvedValue('off');
    mockCheckKlaviyoSmsOptIn.mockResolvedValue({ subscribed: false, consent: 'UNSUBSCRIBED' });
    mockUnsubscribeKlaviyoSms.mockResolvedValue({ ok: true });
    mockAddToStopSet.mockResolvedValue(true);
    mockRemoveMemberByPhone.mockResolvedValue(true);
    mockClaimAppliedFollowupSend.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('hands off to web app at message limit and skips chat route', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 9 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('continue in our web chat');
    expect(res.headers.get('x-ratelimit-limit')).toBe('120');
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(session.smsHandoffToWeb).toBe(true);
    expect(session.smsInboundCount).toBe(10);
  });

  it('returns pending call-us copy for YES on a pending offer while sms upgrades are on hold', async () => {
    process.env.SMS_UPGRADE_STATUS = 'pending';
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-pending-hold',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('upgrade-by-text feature is still pending');
    expect(text).toContain('(888) 677-0055');
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(session.lastUpgradeOfferAppointmentId).toBe('appt-1');
    expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    expect(mockEvaluateUpgradeOpportunityForProfile).not.toHaveBeenCalled();
  });

  it('returns rate-limit headers on invalid signature responses', async () => {
    mockIsValidTwilioSignature.mockReturnValue(false);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-bad-sig',
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain('Invalid Twilio signature');
    expect(res.headers.get('x-ratelimit-limit')).toBe('120');
    expect(res.headers.get('x-ratelimit-backend')).toBe('memory');
  });

  it('processes normal inbound SMS below handoff limit', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 2 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockParseTwilioFormBody.mockReturnValue({
      From: '+12134401333',
      Body: 'What time is my appointment?',
      MessageSid: 'SM-in-chat-1',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=What+time+is+my+appointment%3F&MessageSid=SM-in-chat-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('Handled in chat');
    expect(mockPostChatMessage).toHaveBeenCalledTimes(1);
    expect(session.smsInboundCount).toBe(3);
  });

  it('handles YES deterministically when profile and opportunity are available', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 0 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+12134401333',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      isMember: true,
      pricing: { memberDelta: 40, memberTotal: 139, walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: true,
      reason: 'applied',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // PR-B: the immediate reply is the deterministic manual-confirm; an apply
    // success is conveyed by a follow-up SMS once the booking-edit apply is on.
    expect(text).toContain('team will confirm');
    expect(text).not.toContain("You're all set");
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(mockReverifyAndApplyUpgradeForProfile).toHaveBeenCalled();
    expect(mockLogSupportIncident).not.toHaveBeenCalled();
  });

  it('logs support follow-up when apply succeeds but notes sync fails', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 0 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      fullName: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: true,
      reason: 'applied_cancel_rebook_notes_sync_failed',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-notes-sync',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // PR-B: the immediate reply is the deterministic manual-confirm; an apply
    // success is conveyed by a follow-up SMS once the booking-edit apply is on.
    expect(text).toContain('team will confirm');
    expect(text).not.toContain("You're all set");
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'applied_cancel_rebook_notes_sync_failed',
      name: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
    });
  });

  it('uses pending-offer appointment for YES instead of fresh generic opportunity evaluation', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-pending-1',
        targetDurationMinutes: 50,
        currentDurationMinutes: 30,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+12134401333',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    // If generic reevaluation were used, this would produce no-slot copy.
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'no_upcoming_appointment_in_window',
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'upgrade_mutation_disabled',
      opportunity: {
        appointmentId: 'appt-pending-1',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-pending',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(text).not.toContain('no upgrade slot available');
    expect(mockReverifyAndApplyUpgradeForProfile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        appointmentId: 'appt-pending-1',
        targetDurationMinutes: 50,
      }),
    );
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(session.lastUpgradeOfferAppointmentId).toBe('appt-pending-1');
  });

  it('logs an outbound confirmation row when a verified upgrade succeeds', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-verify-1',
        targetDurationMinutes: 50,
        currentDurationMinutes: 30,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-verify-ok',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // The immediate reply stays the deterministic manual-confirm; the apply
    // success is conveyed by the result-specific follow-up SMS (2026-07-22),
    // logged as a second outbound row.
    expect(text).toContain('team will confirm');
    expect(text).not.toContain("You're all set");
    const outboundCalls = mockLogSmsChatMessages.mock.calls
      .flatMap(call => call[0])
      .filter(row => row && row.direction === 'outbound');
    expect(outboundCalls).toHaveLength(2);
    expect(outboundCalls[0]).toMatchObject({
      direction: 'outbound',
      outcome: 'upgrade_confirmed',
    });
    expect(outboundCalls[0].content).toContain('team will confirm');
    expect(outboundCalls[1].content).toContain("You're all set");
  });

  it('does not claim success and queues follow-up when the upgrade cannot be verified', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-verify-2',
        targetDurationMinutes: 50,
        currentDurationMinutes: 30,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'upgrade_verification_failed',
      reverified: true,
      opportunity: {
        appointmentId: 'appt-verify-2',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-verify-fail',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).not.toContain("You're all set");
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'upgrade_verification_failed',
    });
    // A verification-failed YES must also notify a human (not just log a sheet row).
    expect(mockNotifyUpgradeIncidentOnce).toHaveBeenCalledTimes(1);
    expect(mockNotifyUpgradeIncidentOnce.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'upgrade_verification_failed',
      appointment_id: 'appt-verify-2',
    });
    const outboundCalls = mockLogSmsChatMessages.mock.calls
      .flatMap(call => call[0])
      .filter(row => row && row.direction === 'outbound');
    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0]).toMatchObject({ direction: 'outbound', outcome: 'manual_followup' });
  });

  it('a rejected incident notification never breaks the member-facing reply', async () => {
    mockNotifyUpgradeIncidentOnce.mockRejectedValue(new Error('notify exploded'));
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-verify-3',
        targetDurationMinutes: 50,
        currentDurationMinutes: 30,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_verification_failed', reverified: true });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-verify-fail-3',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(mockNotifyUpgradeIncidentOnce).toHaveBeenCalledTimes(1);
  });

  it('logs an outbound row on the generic YES branch (no pending offer)', async () => {
    // This exercises the SECOND reply site, reached when there is no pending
    // offer but a fresh eligible opportunity is found. Without this test the
    // generic-branch logging could be omitted and the pending-offer tests
    // would still pass.
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 0 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+12134401333',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-generic-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-generic-ok',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // The immediate reply stays the deterministic manual-confirm; the apply
    // success is conveyed by the result-specific follow-up SMS (2026-07-22),
    // logged as a second outbound row.
    expect(text).toContain('team will confirm');
    expect(text).not.toContain("You're all set");
    const outboundCalls = mockLogSmsChatMessages.mock.calls
      .flatMap(call => call[0])
      .filter(row => row && row.direction === 'outbound');
    expect(outboundCalls).toHaveLength(2);
    expect(outboundCalls[0]).toMatchObject({ direction: 'outbound', outcome: 'upgrade_confirmed' });
    expect(outboundCalls[1].content).toContain("You're all set");
  });

  it('returns approved manual confirmation copy when YES has no eligible opportunity', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      fullName: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Upper West Side',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'no_upcoming_appointment_in_window',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-no-slot',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('our team will confirm');
    expect(text).not.toContain('no upgrade slot available');
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
  });

  it('falls back to chat instead of offering 90-minute upgrades over sms', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+12134401333',
      tier: '50',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-90',
      currentDurationMinutes: 50,
      targetDurationMinutes: 90,
      pricing: { walkinDelta: 110, walkinTotal: 279 },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-90-blocked',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // PR-B: YES never routes to the chat route. A 90-minute-only opportunity is
    // out of SMS policy, so the immediate reply is the deterministic manual
    // confirm and a support incident is queued in the deferred work.
    expect(text).toContain('team will confirm');
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'duration_offer_not_allowed',
    });
  });

  it('returns human-finalization copy when upgrade mutation is disabled', async () => {
    process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 0 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+12134401333',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'upgrade_mutation_disabled',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('confirm it before your appointment');
    expect(mockLookupMember).not.toHaveBeenCalled();
    expect(mockEvaluateUpgradeOpportunityForProfile).not.toHaveBeenCalled();
    expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'upgrade_mutation_disabled',
      phone: '+12134401333',
    });
  });

  it('returns add-on confirmation with member/non-member pricing from pending offer', async () => {
    process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Antioxidant Peel',
        isMember: false,
        pricing: { memberPrice: 76, walkinPrice: 95 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // Sentence-cased article; a KNOWN non-member is never teased with member
    // pricing (owner call 2026-07-22 after the live test read wrong).
    expect(text).toContain('An Antioxidant Peel is $95.');
    expect(text).not.toContain('members get 20% off');
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(mockLookupMember).not.toHaveBeenCalled();
    expect(mockEvaluateUpgradeOpportunityForProfile).not.toHaveBeenCalled();
    expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'manual_addon_confirmation',
    });
  });

  it('quotes the member price to a KNOWN member in the add-on confirmation', async () => {
    process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Antioxidant Peel',
        isMember: true,
        pricing: { memberPrice: 76, walkinPrice: 95 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('An Antioxidant Peel is $76 with your membership.');
    expect(text).not.toContain('members get 20% off');
  });

  it('keeps the generic member note only when membership is UNKNOWN on the pending add-on offer', async () => {
    process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Antioxidant Peel',
        pricing: { memberPrice: 76, walkinPrice: 95 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('An Antioxidant Peel is $95 (members get 20% off).');
  });

  it('applies pending add-on YES through the live mutation path when enabled', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: {
        clientId: 'client-1',
        phone: '+12134401333',
      },
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnCode: 'antioxidant_peel',
        addOnName: 'Antioxidant Peel',
        pricing: { memberPrice: 40, walkinPrice: 50 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: true,
      reason: 'applied_addon_booking_from_appointment',
      mutationRoot: 'bookingCreateFromAppointment+bookingAddServiceAddon+bookingComplete',
      updatedAppointmentId: 'appt-1',
      opportunity: {
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnCode: 'antioxidant_peel',
        addOnName: 'Antioxidant Peel',
      },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-addon-apply-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // PR-B: the immediate reply is the deterministic manual-confirm; an apply
    // success is conveyed by a follow-up SMS once the booking-edit apply is on.
    expect(text).toContain('team will confirm');
    expect(text).not.toContain("You're all set");
    expect(mockReverifyAndApplyUpgradeForProfile).toHaveBeenCalledWith(
      session.memberProfile,
      expect.objectContaining({
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnCode: 'antioxidant_peel',
      }),
    );
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(mockLogSupportIncident).not.toHaveBeenCalled();
  });

  it('queues manual follow-up when safe add-on append fails', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: {
        clientId: 'client-append-fail',
        phone: '+12134401333',
      },
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-append-fail',
        addOnCode: 'antioxidant_peel',
        addOnName: 'Antioxidant Peel',
        pricing: { memberPrice: 40, walkinPrice: 50 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'addon_booking_from_appointment_failed',
      reverified: true,
      opportunity: {
        offerKind: 'addon',
        appointmentId: 'appt-append-fail',
        addOnCode: 'antioxidant_peel',
        addOnName: 'Antioxidant Peel',
      },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-addon-append-fail',
    });

    const res = await POST(req);
    const text = await res.text();

    // A failed non-destructive append must never claim the add-on was applied.
    // The member gets approved manual-confirmation copy, the original appointment
    // is left untouched, and an ops incident is queued for human follow-up.
    expect(res.status).toBe(200);
    expect(text).not.toContain("You're all set");
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'addon_booking_from_appointment_failed',
    });
  });

  it('recovers a remote active session by phone and finalizes pending add-on YES without chat fallback', async () => {
    process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
    const remoteSession = {
      id: 'sess-remote',
      status: 'active',
      lastActivity: '2026-03-28T19:20:00.000Z',
      smsInboundCount: 0,
      memberProfile: {
        phone: '+12134401333',
      },
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-remote-1',
        addOnName: 'Antioxidant Peel',
        isMember: true,
        pricing: { memberPrice: 40, walkinPrice: 50 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue(null);
    mockGetAllActiveSessions.mockResolvedValue([{ id: 'sess-remote' }]);
    mockGetSession.mockImplementation(async (sessionId) => {
      if (sessionId === 'sess-remote') return remoteSession;
      return null;
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-remote-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    // This pending offer is a KNOWN member, so the ack quotes the member price
    // (copy contract 2026-07-22; the old walk-in-with-discount-note copy was the bug).
    expect(text).toContain('An Antioxidant Peel is $40 with your membership.');
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(remoteSession.pendingUpgradeOffer).toBeNull();
    expect(mockBindPhoneToSession).toHaveBeenCalledWith('+12134401333', 'sess-remote');
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'manual_addon_confirmation',
      phone: '+12134401333',
    });
  });

  it('does not expose disallowed add-on names in manual confirmation SMS', async () => {
    process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Hydradermabrasion',
        isMember: false,
        pricing: { memberPrice: 76, walkinPrice: 95 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('The add-on is $95');
    expect(text).not.toContain('Hydradermabrasion');
  });

  it('returns fast approved YES copy when profile lookup misses and no pending offer context is recoverable', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 0 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockResolvedValue(session);
    mockLookupMember.mockResolvedValue(null);

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-fast-fallback',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('Thanks for replying YES. We received your request');
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'member_lookup_failed_after_yes',
      phone: '+12134401333',
    });
  });

  it('logs support incident and returns approved manual-finalization copy when mutation attempt fails', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-1',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      fullName: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'upgrade_mutation_failed',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(text).not.toContain('Please use');
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(session.lastUpgradeOfferAppointmentId).toBe('appt-1');
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'upgrade_mutation_failed',
      name: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
    });
  });

  it('writes the Boulevard rejection text into the support incident (PR-1 de-silence)', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-1',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      fullName: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'duration_booking_create_failed',
      error: { stage: 'graphql', errors: [{ message: 'Service is not bookable' }] },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
    });

    const res = await POST(req);
    await res.text();
    await flushDeferred();

    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    const incident = mockLogSupportIncident.mock.calls[0][0];
    expect(incident.reason).toBe('duration_booking_create_failed');
    // The actual Boulevard text rides into the incident so the team sees WHY.
    expect(incident.user_message).toContain('Service is not bookable');
    expect(incident.user_message).toContain('boulevardError=');
  });

  it('returns approved manual-finalization copy when reverify says slot is no longer available', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-2',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      fullName: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-2',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'no_longer_available',
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-no-longer',
    });

    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(text).not.toContain('no longer available');
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'no_longer_available',
      name: 'Matt Maroone',
      email: 'mattmaroone@gmail.com',
      phone: '+12134401333',
      location: 'Penn Quarter',
    });
  });

  it('echoes the persisted member delta at confirmation (pre-tax, no total claim)', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-1', targetDurationMinutes: 50,
        currentDurationMinutes: 30, isMember: true, deltaDollars: 40, totalDollars: 139,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({ clientId: 'client-1', phone: '+12134401333', tier: '30', accountStatus: 'ACTIVE' });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50, isMember: true,
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_disabled' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST', headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-conf-1',
    });
    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('for $40 more');
    expect(text).not.toContain('20% off');
    expect(text).not.toContain('total');
    expect(text).not.toContain('%'); // zero percentage language anywhere in the duration confirmation
  });

  it('echoes the persisted non-member delta at confirmation', async () => {
    const session = {
      id: 'sess-2', status: 'active', smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-2', targetDurationMinutes: 50,
        currentDurationMinutes: 30, isMember: false, deltaDollars: 50, totalDollars: 169,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-2');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({ clientId: 'client-2', phone: '+12134401334', tier: null, accountStatus: null });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-2', currentDurationMinutes: 30, targetDurationMinutes: 50, isMember: false,
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_disabled' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST', headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401334&Body=Yes&MessageSid=SM-in-conf-2',
    });
    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(text).toContain('for $50 more');
  });

  describe('offer/confirmation delta parity', () => {
    const cases = [
      { label: 'member $99', deltaDollars: 40, totalDollars: 139, isMember: true, phone: '+12134401350' },
      { label: 'non-member', deltaDollars: 50, totalDollars: 169, isMember: false, phone: '+12134401351' },
    ];
    for (const c of cases) {
      it(`confirmation renders the same delta the offer persisted (${c.label})`, async () => {
        const session = {
          id: `sess-${c.label}`, status: 'active', smsInboundCount: 0,
          pendingUpgradeOffer: {
            offerKind: 'duration', appointmentId: 'appt-x', targetDurationMinutes: 50, currentDurationMinutes: 30,
            isMember: c.isMember, deltaDollars: c.deltaDollars, totalDollars: c.totalDollars,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          },
        };
        mockGetSessionIdForPhone.mockReturnValue(session.id);
        mockGetSession.mockReturnValue(session);
        mockLookupMember.mockResolvedValue({ clientId: 'c', phone: c.phone, tier: c.isMember ? '30' : null, accountStatus: c.isMember ? 'ACTIVE' : null });
        mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: true, appointmentId: 'appt-x', currentDurationMinutes: 30, targetDurationMinutes: 50, isMember: c.isMember });
        mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_disabled' });

        const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
          method: 'POST', headers: { 'x-twilio-signature': 'sig' },
          body: `From=${encodeURIComponent(c.phone)}&Body=Yes&MessageSid=SM-${c.label.replace(/\W/g, '')}`,
        });
        const text = await (await POST(req)).text();
        expect(text).toContain(`for $${c.deltaDollars} more`);
      });
    }
  });

  it('returns the YES reply without awaiting the Boulevard apply (never-resolving reverify)', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50,
        deltaDollars: 50, totalDollars: 169, pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({ clientId: 'client-1', phone: '+12134401333', tier: '30', accountStatus: 'ACTIVE' });
    // The Boulevard apply never settles. If the reply path awaited it, POST would hang.
    mockReverifyAndApplyUpgradeForProfile.mockReturnValue(new Promise(() => {}));

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST', headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-instant-yes',
    });
    const res = await POST(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('team will confirm');
  });

  it('a thrown deferred task does not affect the already-sent YES reply', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50,
        deltaDollars: 50, totalDollars: 169, pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({ clientId: 'client-1', phone: '+12134401333', tier: '30', accountStatus: 'ACTIVE' });
    mockReverifyAndApplyUpgradeForProfile.mockRejectedValue(new Error('boulevard exploded'));

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST', headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-throw-bg',
    });
    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('team will confirm');
  });

  it('returns the NO decline immediately without calling Boulevard', async () => {
    const session = {
      id: 'sess-1', status: 'active', smsInboundCount: 0,
      pendingUpgradeOffer: {
        offerKind: 'duration', appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50,
        deltaDollars: 50, totalDollars: 169, pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'No', MessageSid: 'SM-no-1' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST', headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=No&MessageSid=SM-no-1',
    });
    const res = await POST(req);
    const text = await res.text();
    await flushDeferred();

    expect(res.status).toBe(200);
    expect(text).toContain('keep your appointment as-is');
    expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    expect(session.pendingUpgradeOffer).toBeNull();
  });

  // Outcome-truth follow-up: the instant TwiML reply goes out before the deferred
  // apply, so a COMPLETED apply (bookingComplete success) must be announced by a
  // result-specific follow-up SMS from the deferred worker. A non-applied YES
  // keeps the manual-confirm string as the last word and sends NOTHING else.
  describe('inbound STOP handling', () => {
    function stopRequest() {
      return new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
        method: 'POST',
        headers: { 'x-twilio-signature': 'sig' },
        body: 'From=%2B12134401333&Body=STOP&MessageSid=SM-stop-1',
      });
    }

    beforeEach(() => {
      mockParseTwilioFormBody.mockReturnValue({
        From: '+12134401333',
        Body: 'STOP',
        MessageSid: 'SM-stop-1',
      });
    });

    it('records the opt-out in the STOP set even when the registry scan throws', async () => {
      // The STOP set write is the authoritative TCPA suppression record. A
      // throwing (or hanging) registry cleanup scan must never cost it.
      mockRemoveMemberByPhone.mockRejectedValue(new Error('redis scan blew up'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await POST(stopRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
      warnSpy.mockRestore();
    });

    it('adds to the STOP set BEFORE the slow registry scan runs', async () => {
      const res = await POST(stopRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
      expect(mockRemoveMemberByPhone).toHaveBeenCalledWith('+12134401333');
      expect(mockAddToStopSet.mock.invocationCallOrder[0])
        .toBeLessThan(mockRemoveMemberByPhone.mock.invocationCallOrder[0]);
    });

    it('records the STOP set even when the registry scan hangs (write is not queued behind it)', async () => {
      // A scan that never settles must not delay the authoritative STOP
      // write: the write lands before the scan starts.
      let scanStarted = false;
      mockRemoveMemberByPhone.mockImplementation(() => new Promise(() => { scanStarted = true; }));

      POST(stopRequest());
      await flushDeferred();

      expect(scanStarted).toBe(true);
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
    });

    it('returns the unsubscribe TwiML even when the registry scan hangs (scan is off the reply path)', async () => {
      // Gauntlet 2026-07-22 (codex adversarial P1 + performance review): the
      // O(N) registry scan must not be awaited on the synchronous reply path,
      // or a slow Redis holds the unsubscribe confirmation past Twilio's
      // reply window and Twilio retries the whole webhook.
      mockRemoveMemberByPhone.mockImplementation(() => new Promise(() => {}));

      const res = await POST(stopRequest());
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
    });

    it('queues a support incident when the STOP write cannot be confirmed (no silent unrecorded opt-out)', async () => {
      // addToStopSet swallows Redis errors internally and returns false. The
      // member is still told they are unsubscribed, so an unconfirmed write
      // must become human-visible instead of a warn line.
      mockAddToStopSet.mockResolvedValue(false);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(stopRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
      expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
        issue_type: 'sms_stop_record_failed',
        phone: '+12134401333',
      });
      errorSpy.mockRestore();
    });

    it('does not block the STOP reply or the Klaviyo fallback on the incident write', async () => {
      // Codex round-3 P1: when the STOP write fails, Klaviyo is the remaining
      // suppression fallback, and the incident write does SMTP + Sheets I/O
      // with no deadline. A hung incident backend must not hold the TwiML
      // reply or the Klaviyo unsubscribe.
      mockAddToStopSet.mockResolvedValue(false);
      mockLogSupportIncident.mockImplementation(() => new Promise(() => {}));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(stopRequest());
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockUnsubscribeKlaviyoSms).toHaveBeenCalledWith({ phone: '+12134401333' });
      errorSpy.mockRestore();
    });

    it('queues a support incident when the STOP write throws', async () => {
      mockAddToStopSet.mockRejectedValue(new Error('redis down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await POST(stopRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
      expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
        issue_type: 'sms_stop_record_failed',
      });
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('still propagates the unsubscribe to Klaviyo, even when the deferred registry scan fails', async () => {
      // Pins the TCPA cross-channel propagation across the handler reorder: a
      // registry failure must never cost the Klaviyo unsubscribe.
      mockRemoveMemberByPhone.mockRejectedValue(new Error('redis scan blew up'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(stopRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockUnsubscribeKlaviyoSms).toHaveBeenCalledWith({ phone: '+12134401333' });
      errorSpy.mockRestore();
    });

    it('masks the phone when the deferred registry scan fails with the number in the error text', async () => {
      // The scan now fails inside deferWork's backstop catch, which must be
      // as PII-lean as the send-path catches.
      mockRemoveMemberByPhone.mockRejectedValue(new Error('SCAN failed for member +12134401333'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await POST(stopRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join(' ');
      expect(logged).not.toContain('12134401333');
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('treats STOP with trailing punctuation as an opt-out (never falls through to the chat bot)', async () => {
      // Security review 2026-07-22: "STOP." previously missed the exact-match
      // keyword regex, fell through to the Claude chat route, and left the
      // member with no suppression record anywhere.
      mockParseTwilioFormBody.mockReturnValue({
        From: '+12134401333',
        Body: 'STOP.',
        MessageSid: 'SM-stop-2',
      });

      const res = await POST(stopRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
      expect(mockPostChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('intent classification safety (negative and opt-out language beats affirmative)', () => {
    function requestWith(bodyText) {
      return new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
        method: 'POST',
        headers: { 'x-twilio-signature': 'sig' },
        body: 'From=%2B12134401333&Body=x&MessageSid=SM-intent-1',
      });
    }
    function pendingSession() {
      return {
        id: 'sess-1',
        status: 'active',
        smsInboundCount: 0,
        memberProfile: { phone: '+12134401333', name: 'Matt Maroone', clientId: 'client-1' },
        pendingUpgradeOffer: {
          offerKind: 'duration',
          appointmentId: 'appt-1',
          targetDurationMinutes: 50,
          deltaDollars: 50,
          pricing: { walkinDelta: 50 },
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        },
      };
    }

    it('honors "No thanks, please stop texting me" as a FULL opt-out, never a YES (red team + codex round-5)', async () => {
      // YES_KEYWORDS matches the courtesy word "please" and affirmative used
      // to win ties, so a polite refusal enqueued a REAL paid Boulevard
      // apply. And an explicit stop-texting request must not stop at a
      // decline: it feeds the suppression set like a bare STOP.
      const session = pendingSession();
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockParseTwilioFormBody.mockReturnValue({
        From: '+12134401333',
        Body: 'No thanks, please stop texting me',
        MessageSid: 'SM-intent-1',
      });

      const res = await POST(requestWith());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
      expect(mockUnsubscribeKlaviyoSms).toHaveBeenCalledWith({ phone: '+12134401333' });
      expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it('honors "please stop texting me" as a full opt-out even without a NO keyword', async () => {
      const session = pendingSession();
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockParseTwilioFormBody.mockReturnValue({
        From: '+12134401333',
        Body: 'please stop texting me',
        MessageSid: 'SM-intent-1',
      });

      const res = await POST(requestWith());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('unsubscribed');
      expect(mockAddToStopSet).toHaveBeenCalledWith('+12134401333');
      expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    });

    it('treats an ambiguous bare "please stop" as a decline, not an unsubscribe', async () => {
      // Without an object ("texting", "messaging") the intent is ambiguous,
      // so it declines the offer and leaves consent state alone; the member
      // can always send STOP.
      const session = pendingSession();
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockParseTwilioFormBody.mockReturnValue({
        From: '+12134401333',
        Body: 'please stop',
        MessageSid: 'SM-intent-1',
      });

      const res = await POST(requestWith());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('No problem');
      expect(mockAddToStopSet).not.toHaveBeenCalled();
      expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
    });

    it('still treats a bare "ok" as a YES on a live pending offer', async () => {
      const session = pendingSession();
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'no_longer_available' });
      mockParseTwilioFormBody.mockReturnValue({
        From: '+12134401333',
        Body: 'ok',
        MessageSid: 'SM-intent-1',
      });

      const res = await POST(requestWith());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(text).toContain('we got your YES');
    });
  });

  describe('applied-outcome follow-up SMS', () => {
    function yesRequest() {
      return new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
        method: 'POST',
        headers: { 'x-twilio-signature': 'sig' },
        body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-1',
      });
    }
    function sessionWith(offer) {
      return {
        id: 'sess-1',
        status: 'active',
        smsInboundCount: 0,
        memberProfile: { phone: '+12134401333', name: 'Matt Maroone', clientId: 'client-1' },
        pendingUpgradeOffer: { expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), ...offer },
      };
    }

    it('sends the duration success copy AFTER the apply reports success, instant reply stays manual-confirm', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

      const res = await POST(yesRequest());
      const text = await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      // The instant reply cannot know the outcome and stays the manual-confirm ack.
      expect(text).toContain('Our team will confirm before your appointment.');
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      expect(mockSendTwilioSms.mock.calls[0][0]).toMatchObject({
        to: '+12134401333',
        body: "You're all set, your facial is now 50 minutes for $50 more. See you soon.",
      });
    });

    it('sends the add-on success copy with the MEMBER price for a known member', async () => {
      const session = sessionWith({
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Neck Firming',
        isMember: true,
        pricing: { memberPrice: 20, walkinPrice: 25 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied_addon_booking_from_appointment' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      expect(mockSendTwilioSms.mock.calls[0][0]).toMatchObject({
        to: '+12134401333',
        body: "You're all set, Neck Firming is added to today's facial for $20. See you soon.",
      });
    });

    it('sends the add-on success copy with the WALK-IN price for a known non-member', async () => {
      const session = sessionWith({
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Neck Firming',
        isMember: false,
        pricing: { memberPrice: 20, walkinPrice: 25 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied_addon_booking_from_appointment' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      expect(mockSendTwilioSms.mock.calls[0][0].body).toBe("You're all set, Neck Firming is added to today's facial for $25. See you soon.");
    });

    it('sends NO follow-up when the apply fails: the manual-confirm stays the last word', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'duration_booking_set_durations_warning_block' });

      const res = await POST(yesRequest());
      const text = await res.text();
      await flushDeferred();

      expect(text).toContain('Our team will confirm before your appointment.');
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it('sends NO follow-up when the mutation kill switch is off', async () => {
      process.env.BOULEVARD_ENABLE_UPGRADE_MUTATION = 'false';
      const session = sessionWith({
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Neck Firming',
        isMember: false,
        pricing: { memberPrice: 20, walkinPrice: 25 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);

      const res = await POST(yesRequest());
      const text = await res.text();
      await flushDeferred();

      expect(text).toContain('Our team will confirm before your appointment.');
      expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it('sends NO follow-up when the member cannot be resolved after YES', async () => {
      const session = {
        id: 'sess-1',
        status: 'active',
        smsInboundCount: 0,
        pendingUpgradeOffer: {
          offerKind: 'duration',
          appointmentId: 'appt-1',
          targetDurationMinutes: 50,
          totalDollars: 169,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        },
      };
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockLookupMember.mockResolvedValue(null);

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(mockReverifyAndApplyUpgradeForProfile).not.toHaveBeenCalled();
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it('CARVE-OUT: sends the follow-up to a member who is NOT Klaviyo-subscribed and not on the STOP set (transactional send, marketing gate does not apply)', async () => {
      // Ratified 2026-07-22: this send is a transactional reply to the
      // member's own YES on their own appointment. Klaviyo SUBSCRIBED status
      // must NOT gate it; only the STOP set does. The default beforeEach
      // already reports the member as NOT subscribed, so this test proves the
      // follow-up sends anyway and that Klaviyo is never even consulted.
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockCheckStopSetStrict.mockResolvedValue('off');

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      expect(mockSendTwilioSms.mock.calls[0][0]).toMatchObject({ to: '+12134401333' });
      expect(mockCheckKlaviyoSmsOptIn).not.toHaveBeenCalled();
    });

    it('SUPPRESSES the follow-up when the member is on the STOP set at send time (apply stands, courtesy withheld)', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockCheckStopSetStrict.mockResolvedValue('on');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      // The suppression is logged, and no follow-up outbound row is written.
      expect(logSpy.mock.calls.flat().join(' ')).toContain('suppressed');
      const outboundRows = mockLogSmsChatMessages.mock.calls
        .flatMap(call => call[0])
        .filter(row => row && row.direction === 'outbound');
      expect(outboundRows.map(r => r.content).join(' ')).not.toContain("You're all set");
    });

    it('SUPPRESSES the follow-up when the stop-set check itself throws (never send on doubt)', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockCheckStopSetStrict.mockRejectedValue(new Error('redis down'));

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it("SUPPRESSES the follow-up when the stop-set state is 'unknown' (no Redis answer): never send on doubt", async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        deltaDollars: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockCheckStopSetStrict.mockResolvedValue('unknown');

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it('sends OUTCOME-ONLY copy (no dollar figure) on the no-pending-offer re-derive path: never state a price the member was not quoted', async () => {
      const session = {
        id: 'sess-1',
        status: 'active',
        smsInboundCount: 0,
        memberProfile: { phone: '+12134401333', name: 'Matt Maroone', clientId: 'client-1' },
      };
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
        eligible: true,
        appointmentId: 'appt-rederive-1',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        pricing: { walkinDelta: 50, walkinTotal: 169, offeredTotal: 169 },
      });
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      const body = String(mockSendTwilioSms.mock.calls[0][0].body);
      expect(body).toContain("You're all set, your facial is now 50 minutes");
      expect(body).not.toContain('$');
    });

    it('omits the price when a KNOWN member has no resolvable member price (never falls through to walk-in)', async () => {
      const session = sessionWith({
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Neck Firming',
        isMember: true,
        pricing: { walkinPrice: 25 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied_addon_booking_from_appointment' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      const body = String(mockSendTwilioSms.mock.calls[0][0].body);
      expect(body).toContain("Neck Firming is added to today's facial");
      expect(body).not.toContain('$');
    });

    it('omits the price when a duration offer has no persisted deltaDollars (never guesses from quote tables)', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: true,
        pricing: { walkinTotal: 169, offeredTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      const body = String(mockSendTwilioSms.mock.calls[0][0].body);
      expect(body).toContain('your facial is now 50 minutes');
      expect(body).not.toContain('$');
    });

    it('sends exactly ONE follow-up when the same YES is delivered twice (durable send claim)', async () => {
      // Twilio can redeliver a webhook, and the redelivery can land on a
      // fresh serverless instance where in-memory replay state is empty.
      // The durable Redis claim is the only defense; simulate its NX
      // semantics: the first claim wins, every later claim is refused.
      const claimedKeys = new Set();
      mockClaimAppliedFollowupSend.mockImplementation(async (key) => {
        if (claimedKeys.has(key)) return false;
        claimedKeys.add(key);
        return true;
      });
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      // The first delivery clears the pending offer, so the redelivery walks
      // the no-pending re-derive path, finds the SAME appointment, and the
      // apply reports success again. Without the claim this sends twice.
      mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
        eligible: true,
        appointmentId: 'appt-1',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });

      const res1 = await POST(yesRequest());
      await res1.text();
      await flushDeferred();
      const res2 = await POST(yesRequest());
      await res2.text();
      await flushDeferred();

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
    });

    it('re-checks the STOP set AFTER the durable claim and suppresses when STOP landed during the claim await', async () => {
      // Codex P1 (2026-07-22 gauntlet): the claim is itself a network await
      // sitting between the STOP check and the Twilio send. A STOP recorded
      // in exactly that window must still win: the send path re-checks the
      // strict gate after the claim and sends only on a second affirmative
      // 'off'.
      mockCheckStopSetStrict.mockResolvedValueOnce('off').mockResolvedValueOnce('on');
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      expect(mockCheckStopSetStrict).toHaveBeenCalledTimes(2);
      logSpy.mockRestore();
    });

    it('keys the send claim by appointment AND offer kind', async () => {
      // Gauntlet 2026-07-22 (codex adversarial P2 + Claude adversarial 3): an
      // appointment can legitimately receive two different applied changes
      // (duration upgrade and add-on) inside the 24h claim TTL. An
      // appointment-only key would silently swallow the second confirmation
      // while the booking really changed, defeating outcome truth.
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockClaimAppliedFollowupSend).toHaveBeenCalledWith('appt:appt-1:duration');
    });

    it('sends BOTH follow-ups when the same appointment gets an add-on and a duration upgrade (distinct claim keys)', async () => {
      const claimedKeys = new Set();
      mockClaimAppliedFollowupSend.mockImplementation(async (key) => {
        if (claimedKeys.has(key)) return false;
        claimedKeys.add(key);
        return true;
      });
      const session = sessionWith({
        offerKind: 'addon',
        appointmentId: 'appt-1',
        addOnName: 'Neck Firming',
        isMember: true,
        pricing: { memberPrice: 20, walkinPrice: 25 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied_addon_booking_from_appointment' });

      const res1 = await POST(yesRequest());
      await res1.text();
      await flushDeferred();

      // Later the same day: a duration offer on the SAME appointment gets a YES.
      session.pendingUpgradeOffer = {
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: true,
        deltaDollars: 50,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

      const res2 = await POST(yesRequest());
      await res2.text();
      await flushDeferred();

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(2);
    });

    it('does not burn the send claim when the STOP gate already suppressed the follow-up', async () => {
      // A member on the STOP set gets no follow-up AND no claim consumed:
      // the claim exists only to dedupe real sends, and consuming it on a
      // suppressed pass could mask a later legitimate one.
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockCheckStopSetStrict.mockResolvedValue('on');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      expect(mockClaimAppliedFollowupSend).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('suppresses the follow-up when the durable send claim cannot be verified (fail closed)', async () => {
      mockClaimAppliedFollowupSend.mockResolvedValue(false);
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('writes the ack audit row BEFORE the Twilio send so a hung send cannot eat the audit trail', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      let rowsLoggedAtSendTime = -1;
      mockSendTwilioSms.mockImplementation(async () => {
        rowsLoggedAtSendTime = mockLogSmsChatMessages.mock.calls
          .flatMap(call => call[0])
          .filter(row => row && row.direction === 'outbound').length;
        return { sid: 'SM-followup-1' };
      });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      expect(rowsLoggedAtSendTime).toBeGreaterThanOrEqual(1);
    });

    it('logs exactly one outbound row and no success copy when the follow-up send itself fails', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockSendTwilioSms.mockRejectedValue(new Error('twilio down'));

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      const outboundRows = mockLogSmsChatMessages.mock.calls
        .flatMap(call => call[0])
        .filter(row => row && row.direction === 'outbound');
      expect(outboundRows).toHaveLength(1);
      expect(outboundRows[0].content).toContain('team will confirm');
      expect(outboundRows.map(r => r.content).join(' ')).not.toContain("You're all set");
    });

    it('suppresses the follow-up and masks the number when the stop-set RECHECK throws after the claim', async () => {
      // Pins the fail-closed error branch of the post-claim STOP re-check,
      // the one send-path catch the 2026-07-22 testing review found untested.
      mockCheckStopSetStrict
        .mockResolvedValueOnce('off')
        .mockRejectedValueOnce(new Error('recheck failed for +12134401333'));
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('stop-set recheck threw');
      expect(logged).not.toContain('12134401333');
      errorSpy.mockRestore();
    });

    it('falls back to a phone-keyed claim when no appointment id survived the apply', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        targetDurationMinutes: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockClaimAppliedFollowupSend).toHaveBeenCalledWith('phone:2134401333:duration');
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
    });

    it('logs NO full phone number when the follow-up send fails (PII masked to last 4)', async () => {
      // Twilio error text echoes the To number. The send-path error logs must
      // carry at most the last 4 digits.
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        isMember: false,
        deltaDollars: 50,
        totalDollars: 169,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockSendTwilioSms.mockRejectedValue(new Error("The 'To' phone number +12134401333 is not currently reachable"));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('applied follow-up send failed');
      expect(logged).not.toContain('12134401333');
      expect(logged).toContain('1333');
      errorSpy.mockRestore();
    });

    it('logs NO full phone number when the stop-set check throws with the number in the error text', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockCheckStopSetStrict.mockRejectedValue(new Error('lookup failed for +12134401333'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('stop-set check threw');
      expect(logged).not.toContain('12134401333');
      errorSpy.mockRestore();
    });

    it('logs NO full phone number when the send claim throws with the number in the error text', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });
      mockClaimAppliedFollowupSend.mockRejectedValue(new Error('claim write failed for +12134401333'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('follow-up send claim threw');
      expect(logged).not.toContain('12134401333');
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('sends NO follow-up when the deferred apply itself throws', async () => {
      const session = sessionWith({
        offerKind: 'duration',
        appointmentId: 'appt-1',
        targetDurationMinutes: 50,
        totalDollars: 169,
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-1');
      mockGetSession.mockReturnValue(session);
      mockReverifyAndApplyUpgradeForProfile.mockRejectedValue(new Error('boulevard 500'));

      const res = await POST(yesRequest());
      await res.text();
      await flushDeferred();

      expect(res.status).toBe(200);
      expect(mockSendTwilioSms).not.toHaveBeenCalled();
    });

    it('never says "your facial is now 50 minutes" on any path where the apply did not succeed', async () => {
      const failures = [
        { success: false, reason: 'no_longer_available' },
        { success: false, reason: 'upgrade_booking_failed' },
        { success: false, reason: 'duration_booking_staff_window_not_clear' },
      ];
      for (const result of failures) {
        vi.clearAllMocks();
        mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0, limit: 120, remaining: 119, backend: 'memory' });
        mockBuildRateLimitHeaders.mockReturnValue({});
        mockGetClientIP.mockReturnValue('127.0.0.1');
        mockSaveSession.mockImplementation(async (s) => s);
        mockGetReplyForMessageSid.mockReturnValue(null);
        mockIsValidTwilioSignature.mockReturnValue(true);
        mockNormalizePhone.mockImplementation(value => String(value || ''));
        mockBuildTwimlMessage.mockImplementation(t => `<Response><Message>${t}</Message></Response>`);
        mockParseTwilioFormBody.mockReturnValue({ From: '+12134401333', Body: 'Yes', MessageSid: 'SM-in-1' });
        mockLogSupportIncident.mockResolvedValue({ email: { sent: true }, sheet: { logged: true } });
        mockNotifyUpgradeIncidentOnce.mockResolvedValue({ sent: true, deduped: false });
        mockLogSmsChatMessages.mockResolvedValue({ logged: true, count: 1 });
        mockSendTwilioSms.mockResolvedValue({ sid: 'SM-followup-1' });
        mockCheckStopSetStrict.mockResolvedValue('off');
        mockGetAllActiveSessions.mockResolvedValue([]);
        const session = sessionWith({
          offerKind: 'duration',
          appointmentId: 'appt-1',
          targetDurationMinutes: 50,
          totalDollars: 169,
        });
        mockGetSessionIdForPhone.mockReturnValue('sess-1');
        mockGetSession.mockReturnValue(session);
        mockReverifyAndApplyUpgradeForProfile.mockResolvedValue(result);

        const res = await POST(yesRequest());
        const text = await res.text();
        await flushDeferred();

        expect(text).not.toContain('your facial is now 50 minutes');
        const sentBodies = mockSendTwilioSms.mock.calls.map(call => String(call[0]?.body || ''));
        expect(sentBodies.join(' ')).not.toContain('your facial is now 50 minutes');
        expect(mockSendTwilioSms).not.toHaveBeenCalled();
      }
    });
  });
});
