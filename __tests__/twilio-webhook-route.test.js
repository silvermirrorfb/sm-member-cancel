import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckRateLimit = vi.fn();
const mockGetClientIP = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
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

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  getClientIP: (...args) => mockGetClientIP(...args),
}));

vi.mock('../src/lib/sessions.js', () => ({
  createSession: (...args) => mockCreateSession(...args),
  getSession: (...args) => mockGetSession(...args),
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

import { POST } from '../src/app/api/sms/twilio/webhook/route.js';

describe('twilio webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
    mockGetClientIP.mockReturnValue('127.0.0.1');
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
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(session.smsHandoffToWeb).toBe(true);
    expect(session.smsInboundCount).toBe(10);
  });

  it('processes normal inbound SMS below handoff limit', async () => {
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 2 };
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
      targetDurationMinutes: 50,
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
    expect(text).toContain('Confirmed. You are upgraded to 50 minutes');
    expect(mockPostChatMessage).not.toHaveBeenCalled();
    expect(mockReverifyAndApplyUpgradeForProfile).toHaveBeenCalled();
  });
});
