import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockResolveBoulevardLocationInput = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockBuildSystemPromptWithProfile = vi.fn();
const mockFormatProfileForPrompt = vi.fn();
const mockBindPhoneToSession = vi.fn();
const mockGetSessionIdForPhone = vi.fn();
const mockGetUpgradeOfferState = vi.fn();
const mockMarkUpgradeOfferEvent = vi.fn();
const mockSendTwilioSms = vi.fn();
const mockEnqueueOutboundCandidate = vi.fn();
const mockPopDueCandidates = vi.fn();
const mockGetOutboundQueueSnapshot = vi.fn();
const mockCheckKlaviyoSmsOptIn = vi.fn();

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: (...args) => mockLookupMember(...args),
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
  formatProfileForPrompt: (...args) => mockFormatProfileForPrompt(...args),
  resolveBoulevardLocationInput: (...args) => mockResolveBoulevardLocationInput(...args),
}));

vi.mock('../src/lib/sessions.js', () => ({
  createSession: (...args) => mockCreateSession(...args),
  getSession: (...args) => mockGetSession(...args),
}));

vi.mock('../src/lib/claude.js', () => ({
  buildSystemPromptWithProfile: (...args) => mockBuildSystemPromptWithProfile(...args),
}));

vi.mock('../src/lib/sms-sessions.js', () => ({
  bindPhoneToSession: (...args) => mockBindPhoneToSession(...args),
  getSessionIdForPhone: (...args) => mockGetSessionIdForPhone(...args),
  getUpgradeOfferState: (...args) => mockGetUpgradeOfferState(...args),
  markUpgradeOfferEvent: (...args) => mockMarkUpgradeOfferEvent(...args),
}));

vi.mock('../src/lib/twilio.js', () => ({
  sendTwilioSms: (...args) => mockSendTwilioSms(...args),
}));

vi.mock('../src/lib/sms-outbound-queue.js', () => ({
  enqueueOutboundCandidate: (...args) => mockEnqueueOutboundCandidate(...args),
  popDueCandidates: (...args) => mockPopDueCandidates(...args),
  getOutboundQueueSnapshot: (...args) => mockGetOutboundQueueSnapshot(...args),
}));

vi.mock('../src/lib/klaviyo.js', () => ({
  checkKlaviyoSmsOptIn: (...args) => mockCheckKlaviyoSmsOptIn(...args),
}));

import { POST } from '../src/app/api/sms/automation/pre-appointment/route.js';

describe('sms automation route', () => {
  beforeEach(() => {
    process.env.SMS_AUTOMATION_TOKEN = 'token';
    vi.clearAllMocks();
    mockGetSessionIdForPhone.mockReturnValue(null);
    mockFormatProfileForPrompt.mockReturnValue('profile');
    mockBuildSystemPromptWithProfile.mockReturnValue('prompt');
    mockCreateSession.mockReturnValue({ id: 'sess-1', status: 'active' });
    mockGetUpgradeOfferState.mockReturnValue(null);
    mockMarkUpgradeOfferEvent.mockReturnValue(null);
    mockResolveBoulevardLocationInput.mockImplementation(value => {
      const raw = String(value || '').trim();
      if (!raw) return { locationId: '' };
      if (/^[0-9a-f-]{36}$/i.test(raw)) return { locationId: `urn:blvd:Location:${raw.toLowerCase()}` };
      return { locationId: raw };
    });
    mockEnqueueOutboundCandidate.mockReturnValue({
      id: 'q-1',
      runAfter: '2026-03-09T14:00:00Z',
      deduped: false,
    });
    mockPopDueCandidates.mockReturnValue([]);
    mockGetOutboundQueueSnapshot.mockReturnValue({ size: 0, earliestRunAfter: null });
    mockCheckKlaviyoSmsOptIn.mockResolvedValue({
      allowed: true,
      reason: null,
      matchedBy: 'phone',
      profileId: 'klyv-1',
      consent: 'SUBSCRIBED',
      canReceiveSmsMarketing: true,
    });
  });

  it('queues candidates outside send window before any lookups', async () => {
    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        now: '2026-03-09T06:00:00Z', // 1:00 AM ET
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          { firstName: 'Debbie', lastName: 'Von Ahrens', email: 'debbievonahrens@mac.com' },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sendWindow.allowed).toBe(false);
    expect(body.results[0].reason).toBe('queued_outside_send_window');
    expect(body.results[0].status).toBe('queued');
    expect(mockLookupMember).not.toHaveBeenCalled();
  });

  it('tries both email and phone contacts for higher-accuracy matching', async () => {
    mockLookupMember
      .mockResolvedValueOnce(null) // email miss
      .mockResolvedValueOnce({
        clientId: 'client-1',
        phone: '+19175551234',
        tier: '30',
        firstName: 'Debbie',
        name: 'Debbie Von Ahrens',
      }); // phone hit

    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      isMember: true,
      currentDurationMinutes: 30,
      startOn: '2026-03-09T18:00:00Z',
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'old@example.com',
            phone: '+1 (917) 555-1234',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('dry_run');
    expect(body.results[0].matchedContact).toContain('917');
    expect(mockLookupMember).toHaveBeenCalledTimes(2);
  });

  it('can process queued work with useQueuedOnly', async () => {
    mockPopDueCandidates.mockReturnValue([
      {
        id: 'q-2',
        payload: {
          candidate: {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'debbievonahrens@mac.com',
          },
          options: {},
        },
      },
    ]);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      isMember: true,
      currentDurationMinutes: 30,
      startOn: '2026-03-09T18:00:00Z',
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        useQueuedOnly: true,
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary.total).toBe(1);
    expect(body.results[0].source).toBe('queued');
    expect(body.results[0].queueId).toBe('q-2');
  });

  it('skips outbound message when klaviyo sms consent is not subscribed', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      isMember: true,
      currentDurationMinutes: 30,
      startOn: '2026-03-09T18:00:00Z',
    });
    mockCheckKlaviyoSmsOptIn.mockResolvedValue({
      allowed: false,
      reason: 'klaviyo_sms_not_subscribed',
      matchedBy: 'phone',
      profileId: 'klyv-2',
      consent: 'UNSUBSCRIBED',
      canReceiveSmsMarketing: false,
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: false,
        liveApproval: true,
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'debbie@example.com',
            phone: '+1 (917) 555-1234',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('skipped');
    expect(body.results[0].reason).toBe('klaviyo_sms_not_subscribed');
    expect(body.results[0].klaviyo.profileId).toBe('klyv-2');
    expect(mockSendTwilioSms).not.toHaveBeenCalled();
  });

  it('allows outbound processing when klaviyo consent is valid', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      isMember: true,
      currentDurationMinutes: 30,
      startOn: '2026-03-09T18:00:00Z',
    });
    mockCheckKlaviyoSmsOptIn.mockResolvedValue({
      allowed: true,
      reason: null,
      matchedBy: 'phone',
      profileId: 'klyv-3',
      consent: 'SUBSCRIBED',
      canReceiveSmsMarketing: true,
    });
    mockSendTwilioSms.mockResolvedValue({ sid: 'SM123' });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: false,
        liveApproval: true,
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'debbie@example.com',
            phone: '+1 (917) 555-1234',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('sent');
    expect(body.results[0].twilioSid).toBe('SM123');
    expect(body.results[0].klaviyo.profileId).toBe('klyv-3');
    expect(mockSendTwilioSms).toHaveBeenCalledTimes(1);
  });

  it('blocks live sends without manual liveApproval flag', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: false,
        now: '2026-03-09T15:00:00Z',
        candidates: [
          {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'debbie@example.com',
            phone: '+1 (917) 555-1234',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toContain('locked');
    expect(mockSendTwilioSms).not.toHaveBeenCalled();
    expect(mockLookupMember).not.toHaveBeenCalled();
  });

  it('uses reminder offer type around one-hour window when initial offer already sent', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      isMember: true,
      currentDurationMinutes: 30,
      startOn: '2026-03-09T18:00:00Z',
    });
    mockGetUpgradeOfferState.mockReturnValue({
      initialSentAt: '2026-03-09T12:00:00Z',
      reminderSentAt: null,
    });
    mockCreateSession.mockReturnValue({
      id: 'sess-1',
      status: 'active',
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        createdAt: '2026-03-09T12:00:00Z',
        expiresAt: '2026-03-09T12:10:00Z',
      },
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        now: '2026-03-09T17:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'debbie@example.com',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('dry_run');
    expect(body.results[0].offerType).toBe('reminder');
  });

  it('skips offers when appointment was already declined', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      isMember: true,
      currentDurationMinutes: 30,
      startOn: '2026-03-09T18:00:00Z',
    });
    mockGetUpgradeOfferState.mockReturnValue({
      initialSentAt: '2026-03-09T12:00:00Z',
      declinedAt: '2026-03-09T12:05:00Z',
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        now: '2026-03-09T17:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Debbie',
            lastName: 'Von Ahrens',
            email: 'debbie@example.com',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('skipped');
    expect(body.results[0].reason).toBe('offer_declined');
  });
});
