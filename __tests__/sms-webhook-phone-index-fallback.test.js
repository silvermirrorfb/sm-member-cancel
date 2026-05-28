import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCheckRateLimit = vi.fn();
const mockGetClientIP = vi.fn();
const mockGetSession = vi.fn();
const mockSaveSession = vi.fn();
const mockGetAllActiveSessions = vi.fn();
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
const mockGetClientById = vi.fn();
const mockLookupClientIdByPhoneFromIndex = vi.fn();
const mockLogSupportIncident = vi.fn();
const mockLogSmsChatMessages = vi.fn();
const mockBindPhoneToSession = vi.fn();
const mockCreateSession = vi.fn();
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
  getClientById: (...args) => mockGetClientById(...args),
}));

vi.mock('../src/lib/sms-member-registry.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    lookupClientIdByPhoneFromIndex: (...args) => mockLookupClientIdByPhoneFromIndex(...args),
  };
});

vi.mock('../src/lib/notify.js', () => ({
  logSupportIncident: (...args) => mockLogSupportIncident(...args),
  logSmsChatMessages: (...args) => mockLogSmsChatMessages(...args),
}));

const { POST } = await import('../src/app/api/sms/twilio/webhook/route.js');

function makeFormRequest() {
  return new Request('http://localhost/api/sms/twilio/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'fake-but-mock-validator-accepts-anything',
    },
    body: 'From=%2B12025551234&Body=Yes&MessageSid=SM-in-test',
  });
}

function activeSessionNoProfile() {
  return {
    id: 'sess-test-1',
    pendingUpgradeOffer: null,
    memberProfile: null,
    memberId: null,
    lastUpgradeOfferAppointmentId: null,
    messages: [],
  };
}

describe('twilio webhook phone-index lookup fallback', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      SMS_UPGRADE_STATUS: 'live',
    };
    vi.clearAllMocks();
    mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0, limit: 120, remaining: 119, backend: 'memory' });
    mockBuildRateLimitHeaders.mockReturnValue({});
    mockGetClientIP.mockReturnValue('127.0.0.1');
    mockGetAllActiveSessions.mockResolvedValue([]);
    mockSaveSession.mockImplementation(async (s) => s);
    mockGetReplyForMessageSid.mockReturnValue(null);
    mockIsValidTwilioSignature.mockReturnValue(true);
    mockNormalizePhone.mockImplementation(v => String(v || ''));
    mockBuildTwimlMessage.mockImplementation(t => `<Response><Message>${t}</Message></Response>`);
    mockParseTwilioFormBody.mockReturnValue({ From: '+12025551234', Body: 'Yes', MessageSid: 'SM-in-test' });
    mockGetSession.mockResolvedValue(activeSessionNoProfile());
    mockGetSessionIdForPhone.mockResolvedValue('sess-test-1');
    mockBindPhoneToSession.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue(activeSessionNoProfile());
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'no_pending_offer' });
    mockLookupMember.mockResolvedValue(null);
    mockGetClientById.mockResolvedValue(null);
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue(null);
    mockLogSupportIncident.mockResolvedValue({});
    mockLogSmsChatMessages.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('registry hit: getClientById is called, lookupMember is NOT called', async () => {
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue({ clientId: 'urn:blvd:Client:abc', locationId: null });
    // Resolved client's phone matches the inbound +12025551234, so the fast
    // path is a genuine hit and must short-circuit without a scan.
    mockGetClientById.mockResolvedValue({ clientId: 'urn:blvd:Client:abc', firstName: 'Test', lastName: 'Member', phone: '+12025551234' });
    const res = await POST(makeFormRequest());
    expect(res.status).toBe(200);
    expect(mockGetClientById).toHaveBeenCalledWith('urn:blvd:Client:abc');
    expect(mockLookupMember).not.toHaveBeenCalled();
  });

  it('registry miss with fast scan: falls through to lookupMember and uses returned profile', async () => {
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue(null);
    mockLookupMember.mockResolvedValue({ clientId: 'urn:blvd:Client:fast', firstName: 'Fast', lastName: 'Path' });
    const res = await POST(makeFormRequest());
    expect(res.status).toBe(200);
    expect(mockLookupMember).toHaveBeenCalledWith('', '+12025551234');
    expect(mockGetClientById).not.toHaveBeenCalled();
  });

  it('registry hit but getClientById returns null: falls through to lookupMember', async () => {
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue({ clientId: 'urn:blvd:Client:stale', locationId: null });
    mockGetClientById.mockResolvedValue(null);
    mockLookupMember.mockResolvedValue({ clientId: 'urn:blvd:Client:resolved' });
    const res = await POST(makeFormRequest());
    expect(res.status).toBe(200);
    expect(mockGetClientById).toHaveBeenCalledWith('urn:blvd:Client:stale');
    expect(mockLookupMember).toHaveBeenCalledWith('', '+12025551234');
  });

  it('registry hit but indexed client phone no longer matches inbound: stale index, falls through to lookupMember', async () => {
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue({ clientId: 'urn:blvd:Client:wrongnum', locationId: null });
    // The index points at a client whose CURRENT phone is a different number
    // than the inbound +12025551234 (stale or reassigned index entry).
    mockGetClientById.mockResolvedValue({
      clientId: 'urn:blvd:Client:wrongnum',
      firstName: 'Stale',
      lastName: 'Entry',
      phone: '+19998887777',
    });
    mockLookupMember.mockResolvedValue({
      clientId: 'urn:blvd:Client:correct',
      firstName: 'Correct',
      lastName: 'Member',
      phone: '+12025551234',
    });
    const res = await POST(makeFormRequest());
    expect(res.status).toBe(200);
    expect(mockGetClientById).toHaveBeenCalledWith('urn:blvd:Client:wrongnum');
    // A stale index must NOT short-circuit; the webhook must verify the phone
    // and fall through to the slow scan when it does not match.
    expect(mockLookupMember).toHaveBeenCalledWith('', '+12025551234');
  });

  it('registry miss + scan exceeds 12s deadline: returns 200 with manual-confirm TwiML in <13s', async () => {
    vi.useFakeTimers();
    mockLookupClientIdByPhoneFromIndex.mockResolvedValue(null);
    mockLookupMember.mockReturnValue(new Promise(() => {})); // never resolves
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const postPromise = POST(makeFormRequest());
    // Advance past the 12s scan deadline (PHONE_SCAN_DEADLINE_MS).
    await vi.advanceTimersByTimeAsync(12_500);
    const res = await postPromise;

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('our team will confirm'); // YES_NO_PENDING_MANUAL_REPLY substring
    const errMessages = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(errMessages).toContain('phone-scan timeout');
    consoleErrorSpy.mockRestore();
  });
});
