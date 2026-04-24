import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Focused integration test: the missed_call + CALLBACK preamble in the
// inbound Twilio webhook. Covers:
//   1. callback-intent reply → logs to CallbackQueue + GA4 + confirmation SMS + closes session
//   2. non-callback reply on a missed_call session → preamble is skipped, flow falls through

const mockCheckRateLimit = vi.fn();
const mockGetClientIP = vi.fn();
const mockBuildRateLimitHeaders = vi.fn();

const mockGetSession = vi.fn();
const mockSaveSession = vi.fn();
const mockCreateSession = vi.fn();
const mockGetAllActiveSessions = vi.fn();
const mockCompleteSession = vi.fn();

const mockGetSessionByPhone = vi.fn();
const mockGetSessionIdForPhone = vi.fn();
const mockBindPhoneToSession = vi.fn();
const mockGetReplyForMessageSid = vi.fn();
const mockStoreReplyForMessageSid = vi.fn();
const mockNormalizePhone = vi.fn();

const mockIsValidTwilioSignature = vi.fn();
const mockParseTwilioFormBody = vi.fn();
const mockBuildTwimlMessage = vi.fn();
const mockSendTwilioSms = vi.fn();

const mockLogCallbackRequest = vi.fn();
const mockLogSupportIncident = vi.fn();
const mockLogSmsChatMessages = vi.fn();

const mockFireGa4Event = vi.fn();

const mockPostChatMessage = vi.fn();
const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockReverifyAndApplyUpgradeForProfile = vi.fn();

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
  completeSession: (...args) => mockCompleteSession(...args),
}));

vi.mock('../src/lib/sms-sessions.js', () => ({
  bindPhoneToSession: (...args) => mockBindPhoneToSession(...args),
  getSessionByPhone: (...args) => mockGetSessionByPhone(...args),
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
}));

vi.mock('../src/lib/notify.js', () => ({
  logCallbackRequest: (...args) => mockLogCallbackRequest(...args),
  logSupportIncident: (...args) => mockLogSupportIncident(...args),
  logSmsChatMessages: (...args) => mockLogSmsChatMessages(...args),
}));

vi.mock('../src/lib/ga4.js', () => ({
  fireGa4Event: (...args) => mockFireGa4Event(...args),
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

function makeRequest({ from = '+19175551234', body = 'CALLBACK', messageSid = 'SM_in_1' } = {}) {
  return {
    url: 'https://sm-member-cancel.vercel.app/api/sms/twilio/webhook',
    headers: new Headers({
      'x-twilio-signature': 'fake',
      'content-type': 'application/x-www-form-urlencoded',
    }),
    text: async () => new URLSearchParams({ From: from, Body: body, MessageSid: messageSid }).toString(),
  };
}

describe('inbound SMS → missed_call CALLBACK preamble', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();

    mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0, limit: 120, remaining: 119, backend: 'memory' });
    mockBuildRateLimitHeaders.mockReturnValue({});
    mockGetClientIP.mockReturnValue('127.0.0.1');
    mockIsValidTwilioSignature.mockReturnValue(true);
    mockBuildTwimlMessage.mockImplementation(text => `<Response><Message>${text}</Message></Response>`);
    mockNormalizePhone.mockImplementation(v => String(v || ''));
    mockGetReplyForMessageSid.mockReturnValue(null);
    mockGetSession.mockResolvedValue(null);
    mockLogSmsChatMessages.mockResolvedValue({ logged: true });
    mockLogCallbackRequest.mockResolvedValue({ ok: true, rowNumber: 2 });
    mockSendTwilioSms.mockResolvedValue({ sid: 'SM_out_1' });
    mockCompleteSession.mockResolvedValue({ id: 'sess-missed', status: 'completed' });
    mockFireGa4Event.mockResolvedValue({ ok: true });
    mockParseTwilioFormBody.mockImplementation(raw => Object.fromEntries(new URLSearchParams(raw)));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('callback intent detected on missed_call session', () => {
    beforeEach(() => {
      mockGetSessionByPhone.mockResolvedValue({
        id: 'sess-missed',
        status: 'active',
        session_mode: 'missed_call',
        origin: 'missed_call_trigger',
        caller_phone: '+19175551234',
        location_called: 'brickell',
        outbound_autotext_sid: 'SM_autotext_77',
        callSid: 'CA_77',
      });
    });

    it('writes the callback row to CallbackQueue', async () => {
      const res = await POST(makeRequest({ body: 'CALLBACK' }));
      expect(res.status).toBe(200);
      expect(mockLogCallbackRequest).toHaveBeenCalledTimes(1);
      const payload = mockLogCallbackRequest.mock.calls[0][0];
      expect(payload).toMatchObject({
        callerPhone: '+19175551234',
        location: 'brickell',
        originalAutotextSid: 'SM_autotext_77',
        requestedVia: 'CALLBACK_keyword',
      });
    });

    it('uses natural_language for phrase-based requests', async () => {
      const res = await POST(makeRequest({ body: 'please call me back' }));
      expect(res.status).toBe(200);
      const payload = mockLogCallbackRequest.mock.calls[0][0];
      expect(payload.requestedVia).toBe('natural_language');
    });

    it('fires GA4 callback_requested event', async () => {
      await POST(makeRequest({ body: 'CALLBACK' }));
      expect(mockFireGa4Event).toHaveBeenCalledWith(
        'callback_requested',
        expect.objectContaining({
          location_name: 'brickell',
          callerPhone: '+19175551234',
          requested_via: 'CALLBACK_keyword',
        }),
      );
    });

    it('sends the confirmation SMS with the formatted location name', async () => {
      await POST(makeRequest({ body: 'CALLBACK' }));
      expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
      const args = mockSendTwilioSms.mock.calls[0][0];
      expect(args.to).toBe('+19175551234');
      expect(args.body).toMatch(/Got it.*Brickell.*call you back/);
    });

    it('closes the session via completeSession with callback_requested outcome', async () => {
      await POST(makeRequest({ body: 'CALLBACK' }));
      expect(mockCompleteSession).toHaveBeenCalledTimes(1);
      const [sessionId, outcome, summary] = mockCompleteSession.mock.calls[0];
      expect(sessionId).toBe('sess-missed');
      expect(outcome).toBe('callback_requested');
      expect(summary).toMatchObject({
        caller_phone: '+19175551234',
        location_called: 'brickell',
        callback_requested_via: 'CALLBACK_keyword',
      });
    });

    it('returns TwiML with the confirmation body', async () => {
      const res = await POST(makeRequest({ body: 'CALLBACK' }));
      const text = await res.text();
      expect(text).toMatch(/Got it.*Brickell.*call you back/);
    });

    it('does not call Claude (runChatMessageForSms) on callback path', async () => {
      await POST(makeRequest({ body: 'CALLBACK' }));
      expect(mockPostChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('missed_call session but no callback intent', () => {
    beforeEach(() => {
      mockGetSessionByPhone.mockResolvedValue({
        id: 'sess-missed',
        status: 'active',
        session_mode: 'missed_call',
        caller_phone: '+19175551234',
        location_called: 'brickell',
        outbound_autotext_sid: 'SM_autotext_77',
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-missed');
      mockGetSession.mockResolvedValue({
        id: 'sess-missed',
        status: 'active',
        smsInboundCount: 0,
      });
      mockPostChatMessage.mockResolvedValue(
        new Response(JSON.stringify({ message: 'general reply' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    it('does NOT write to CallbackQueue', async () => {
      await POST(makeRequest({ body: 'what are your hours' }));
      expect(mockLogCallbackRequest).not.toHaveBeenCalled();
    });

    it('does NOT fire GA4 callback_requested', async () => {
      await POST(makeRequest({ body: 'what are your hours' }));
      const ga4Calls = mockFireGa4Event.mock.calls.filter(c => c[0] === 'callback_requested');
      expect(ga4Calls).toHaveLength(0);
    });

    it('does NOT complete the session', async () => {
      await POST(makeRequest({ body: 'what are your hours' }));
      expect(mockCompleteSession).not.toHaveBeenCalled();
    });

    it('falls through to general handler', async () => {
      const res = await POST(makeRequest({ body: 'what are your hours' }));
      expect(res.status).toBe(200);
      expect(mockPostChatMessage).toHaveBeenCalled();
    });
  });

  describe('non-missed_call sessions are unaffected', () => {
    it('general (widget) session with CALLBACK word in body does not trigger CBQ preamble', async () => {
      mockGetSessionByPhone.mockResolvedValue({
        id: 'sess-general',
        status: 'active',
        session_mode: 'general',
      });
      mockGetSessionIdForPhone.mockReturnValue('sess-general');
      mockGetSession.mockResolvedValue({ id: 'sess-general', status: 'active', smsInboundCount: 0 });
      mockPostChatMessage.mockResolvedValue(
        new Response(JSON.stringify({ message: 'widget reply' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await POST(makeRequest({ body: 'CALLBACK' }));
      expect(mockLogCallbackRequest).not.toHaveBeenCalled();
    });

    it('no indexed session at all: preamble skips, falls through', async () => {
      mockGetSessionByPhone.mockResolvedValue(null);
      mockGetSessionIdForPhone.mockReturnValue(null);
      mockCreateSession.mockResolvedValue({ id: 'sess-new', status: 'active' });
      mockGetSession.mockResolvedValue({ id: 'sess-new', status: 'active', smsInboundCount: 0 });
      mockPostChatMessage.mockResolvedValue(
        new Response(JSON.stringify({ message: 'new reply' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await POST(makeRequest({ body: 'CALLBACK' }));
      expect(mockLogCallbackRequest).not.toHaveBeenCalled();
    });
  });

  describe('preamble robustness', () => {
    it('if getSessionByPhone throws, falls through to existing handler without crashing', async () => {
      mockGetSessionByPhone.mockRejectedValue(new Error('upstash blip'));
      mockGetSessionIdForPhone.mockReturnValue('sess-fallback');
      mockGetSession.mockResolvedValue({ id: 'sess-fallback', status: 'active', smsInboundCount: 0 });
      mockPostChatMessage.mockResolvedValue(
        new Response(JSON.stringify({ message: 'fallback reply' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const res = await POST(makeRequest({ body: 'CALLBACK' }));
      expect(res.status).toBe(200);
      expect(mockLogCallbackRequest).not.toHaveBeenCalled();
    });

    it('if logCallbackRequest throws, still sends confirmation and closes session', async () => {
      mockGetSessionByPhone.mockResolvedValue({
        id: 'sess-missed',
        status: 'active',
        session_mode: 'missed_call',
        caller_phone: '+19175551234',
        location_called: 'brickell',
        outbound_autotext_sid: 'SM_x',
      });
      mockLogCallbackRequest.mockRejectedValue(new Error('sheets down'));

      const res = await POST(makeRequest({ body: 'CALLBACK' }));
      expect(res.status).toBe(200);
      // Degraded-but-functional: customer still gets their confirmation,
      // session still closes. The Sheet miss is logged for ops.
      expect(mockSendTwilioSms).toHaveBeenCalled();
      expect(mockCompleteSession).toHaveBeenCalled();
    });
  });
});
