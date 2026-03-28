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
const originalEnv = process.env;

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  getClientIP: (...args) => mockGetClientIP(...args),
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
}));

vi.mock('../src/app/api/chat/message/route.js', () => ({
  POST: (...args) => mockPostChatMessage(...args),
}));

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: (...args) => mockLookupMember(...args),
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
  reverifyAndApplyUpgradeForProfile: (...args) => mockReverifyAndApplyUpgradeForProfile(...args),
}));

vi.mock('../src/lib/notify.js', () => ({
  logSupportIncident: (...args) => mockLogSupportIncident(...args),
}));

import { POST } from '../src/app/api/sms/twilio/webhook/route.js';

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

    expect(res.status).toBe(200);
    expect(text).toContain("You're all set. See you soon.");
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

    expect(res.status).toBe(200);
    expect(text).toContain("You're all set. See you soon.");
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

    expect(res.status).toBe(200);
    expect(text).toContain('our team will confirm');
    expect(text).not.toContain('no upgrade slot available');
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
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

    expect(res.status).toBe(200);
    expect(text).toContain('an Antioxidant Peel is $95 (members get 20% off).');
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

    expect(res.status).toBe(200);
    expect(text).toContain('an Antioxidant Peel is $50');
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
});
