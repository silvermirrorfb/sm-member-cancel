import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookupMember = vi.fn();
const mockGetClientById = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockResolveBoulevardLocationInput = vi.fn();
const mockGetBoulevardAuthContext = vi.fn();
const mockScanAppointments = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockSaveSession = vi.fn();
const mockBuildSystemPromptWithProfile = vi.fn();
const mockFormatProfileForPrompt = vi.fn();
const mockBindPhoneToSession = vi.fn();
const mockGetSessionIdForPhone = vi.fn();
const mockGetUpgradeOfferState = vi.fn();
const mockGetUpsellCooldown = vi.fn();
const mockMarkUpsellInitialSent = vi.fn();
const mockMarkUpgradeOfferEvent = vi.fn();
const mockSendTwilioSms = vi.fn();
const mockEnqueueOutboundCandidate = vi.fn();
const mockPopDueCandidates = vi.fn();
const mockGetOutboundQueueSnapshot = vi.fn();
const mockCheckKlaviyoSmsOptIn = vi.fn();
const mockLogSmsChatMessages = vi.fn();

vi.mock('../src/lib/boulevard.js', async (importActual) => {
  const actual = await importActual();
  return {
    lookupMember: (...args) => mockLookupMember(...args),
    getClientById: (...args) => mockGetClientById(...args),
    evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
    formatProfileForPrompt: (...args) => mockFormatProfileForPrompt(...args),
    resolveBoulevardLocationInput: (...args) => mockResolveBoulevardLocationInput(...args),
    getBoulevardAuthContext: (...args) => mockGetBoulevardAuthContext(...args),
    scanAppointments: (...args) => mockScanAppointments(...args),
    isInactiveMembershipStatus: actual.isInactiveMembershipStatus,
  };
});

vi.mock('../src/lib/sessions.js', () => ({
  createSession: (...args) => mockCreateSession(...args),
  getSession: (...args) => mockGetSession(...args),
  saveSession: (...args) => mockSaveSession(...args),
}));

vi.mock('../src/lib/claude.js', () => ({
  buildSystemPromptWithProfile: (...args) => mockBuildSystemPromptWithProfile(...args),
}));

vi.mock('../src/lib/sms-sessions.js', () => ({
  bindPhoneToSession: (...args) => mockBindPhoneToSession(...args),
  getSessionIdForPhone: (...args) => mockGetSessionIdForPhone(...args),
  getUpgradeOfferState: (...args) => mockGetUpgradeOfferState(...args),
  getUpsellCooldown: (...args) => mockGetUpsellCooldown(...args),
  markUpsellInitialSent: (...args) => mockMarkUpsellInitialSent(...args),
  markUpgradeOfferEvent: (...args) => mockMarkUpgradeOfferEvent(...args),
}));

vi.mock('../src/lib/twilio.js', () => ({
  sendTwilioSms: (...args) => mockSendTwilioSms(...args),
  trimSmsBodyShort: (value) => value,
}));

vi.mock('../src/lib/sms-outbound-queue.js', () => ({
  enqueueOutboundCandidate: (...args) => mockEnqueueOutboundCandidate(...args),
  popDueCandidates: (...args) => mockPopDueCandidates(...args),
  getOutboundQueueSnapshot: (...args) => mockGetOutboundQueueSnapshot(...args),
}));

vi.mock('../src/lib/klaviyo.js', () => ({
  checkKlaviyoSmsOptIn: (...args) => mockCheckKlaviyoSmsOptIn(...args),
}));

vi.mock('../src/lib/notify.js', () => ({
  logSmsChatMessages: (...args) => mockLogSmsChatMessages(...args),
}));

import { POST } from '../src/app/api/sms/automation/pre-appointment/route.js';

describe('sms automation route', () => {
  beforeEach(() => {
    process.env.SMS_AUTOMATION_TOKEN = 'token';
    process.env.SMS_UPGRADE_STATUS = 'live';
    vi.clearAllMocks();
    mockGetClientById.mockResolvedValue(null);
    mockGetSessionIdForPhone.mockReturnValue(null);
    mockSaveSession.mockImplementation(async (session) => session);
    mockFormatProfileForPrompt.mockReturnValue('profile');
    mockBuildSystemPromptWithProfile.mockReturnValue('prompt');
    mockCreateSession.mockReturnValue({ id: 'sess-1', status: 'active' });
    mockGetUpgradeOfferState.mockReturnValue(null);
    mockGetUpsellCooldown.mockReturnValue(null);
    mockMarkUpsellInitialSent.mockReturnValue(null);
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
    mockGetBoulevardAuthContext.mockReturnValue({
      apiUrl: 'https://dashboard.boulevard.io/api/2020-01/admin',
      headers: { Authorization: 'Basic test' },
      businessId: 'biz',
    });
    mockScanAppointments.mockResolvedValue({ appointments: [] });
    mockLogSmsChatMessages.mockResolvedValue({ logged: true, count: 1 });
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

  it('skips outbound upgrade work entirely while sms upgrades are pending', async () => {
    process.env.SMS_UPGRADE_STATUS = 'pending';

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
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

    expect(res.status).toBe(200);
    expect(body.upgradeStatus).toBe('pending');
    expect(body.results[0].status).toBe('skipped');
    expect(body.results[0].reason).toBe('sms_upgrade_feature_pending');
    expect(body.results[0].message).toContain('upgrade-by-text feature is still pending');
    expect(mockLookupMember).not.toHaveBeenCalled();
    expect(mockSendTwilioSms).not.toHaveBeenCalled();
  });

  it('tries both email and phone contacts for higher-accuracy matching', async () => {
    mockLookupMember
      .mockResolvedValueOnce(null) // email miss
      .mockResolvedValueOnce({
        clientId: 'client-1',
        phone: '+19175551234',
        tier: '30',
        hasMembership: true,
        accountStatus: 'ACTIVE',
        monthlyRate: 99,
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
    expect(body.results[0].message).toContain("there's room to extend your facial today to 50 minutes");
    expect(body.results[0].message).toContain('Reply YES to upgrade or NO to keep your current booking.');
    expect(mockLookupMember).toHaveBeenCalledTimes(2);
  });

  it('skips 50-to-90 duration upgrades in SMS automation', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '50',
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-90',
      targetDurationMinutes: 90,
      pricing: { memberTotal: 189, memberDelta: 60, walkinTotal: 279, walkinDelta: 110 },
      isMember: true,
      currentDurationMinutes: 50,
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
        enableAddonFallback: false,
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
    expect(body.results[0].reason).toBe('sms_target_duration_blocked');
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
      hasMembership: true,
      accountStatus: 'ACTIVE',
      monthlyRate: 99,
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
    expect(body.results[0].status).toBe('dry_run');
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
      hasMembership: true,
      accountStatus: 'ACTIVE',
      monthlyRate: 99,
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
    expect(mockSendTwilioSms.mock.calls[0][0].trimBody).toBeTypeOf('function');
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
      hasMembership: true,
      accountStatus: 'ACTIVE',
      monthlyRate: 99,
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

  it('supports add-on offers with non-member pricing', async () => {
    process.env.SMS_ENABLE_ADDON_FALLBACK = 'true'; // add-on offers require the env kill switch ON
    mockLookupMember.mockResolvedValue({
      clientId: 'client-9',
      phone: '+19175550000',
      tier: null,
      accountStatus: 'ACTIVE',
      firstName: 'Taylor',
      name: 'Taylor Guest',
      email: 'taylor@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'no_upgrade_target_for_duration',
      appointmentId: 'appt-9',
      currentDurationMinutes: 50,
      availableGapMinutes: 10,
      startOn: '2026-03-09T18:00:00Z',
      isMember: false,
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        offerType: 'addon',
        addOnCode: 'antioxidant_peel',
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Taylor',
            lastName: 'Guest',
            email: 'taylor@example.com',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('dry_run');
    expect(body.results[0].offerKind).toBe('addon');
    expect(body.results[0].addOnCode).toBe('antioxidant_peel');
    expect(body.results[0].message).toContain('Antioxidant Peel');
    expect(body.results[0].message).toContain('$50');
    expect(body.results[0].message).not.toContain('members save 20%');
    expect(body.results[0].message).toContain('Reply YES to add it or NO to skip.');
  });

  it('uses the refined add-on copy for Lip Plump and Scrub', async () => {
    process.env.SMS_ENABLE_ADDON_FALLBACK = 'true'; // add-on offers require the env kill switch ON
    mockLookupMember.mockResolvedValue({
      clientId: 'client-10',
      phone: '+19175550001',
      tier: null,
      accountStatus: 'ACTIVE',
      firstName: 'Taylor',
      name: 'Taylor Guest',
      email: 'taylor@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'no_upgrade_target_for_duration',
      appointmentId: 'appt-10',
      currentDurationMinutes: 50,
      availableGapMinutes: 10,
      startOn: '2026-03-09T18:00:00Z',
      isMember: false,
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        offerType: 'addon',
        addOnCode: 'lip_plump_and_scrub',
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Taylor',
            lastName: 'Guest',
            email: 'taylor@example.com',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('dry_run');
    expect(body.results[0].message).toContain('we can add Lip Plump and Scrub');
    expect(body.results[0].message).toContain('Reply YES to add it or NO to skip.');
  });

  it('resolves a discovery candidate by clientId and skips the name lookup', async () => {
    mockGetClientById.mockResolvedValue({
      clientId: 'urn:blvd:Client:abc123',
      phone: '+19175551234',
      tier: '50',
      firstName: 'Rachel',
      name: 'Rachel Martell',
      email: 'rachel@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'no_appointments_available', diagnostics: null });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
      body: JSON.stringify({
        dryRun: true,
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Rachel',
            lastName: 'Martell',
            email: 'rachel@example.com',
            phone: '+1 (917) 555-1234',
            clientId: 'urn:blvd:Client:abc123',
            appointmentId: 'urn:blvd:Appointment:xyz789',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetClientById).toHaveBeenCalledWith('urn:blvd:Client:abc123');
    expect(mockLookupMember).not.toHaveBeenCalled();
    expect(mockEvaluateUpgradeOpportunityForProfile).toHaveBeenCalled();
    expect(body.results[0].reason).not.toBe('member_not_found');
  });

  it('falls back to lookupMember when getClientById returns null', async () => {
    mockGetClientById.mockResolvedValue(null);
    mockLookupMember.mockResolvedValue({
      clientId: 'urn:blvd:Client:abc123',
      phone: '+19175551234',
      tier: '30',
      firstName: 'Rachel',
      name: 'Rachel Martell',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: false, reason: 'no_appointments_available', diagnostics: null });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
      body: JSON.stringify({
        dryRun: true,
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Rachel',
            lastName: 'Martell',
            email: 'rachel@example.com',
            phone: '+1 (917) 555-1234',
            clientId: 'urn:blvd:Client:abc123',
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetClientById).toHaveBeenCalledWith('urn:blvd:Client:abc123');
    expect(mockLookupMember).toHaveBeenCalled();
    expect(body.results[0].reason).not.toBe('member_not_found');
  });

  // ===================================================================
  // SMS_ENABLE_ADDON_FALLBACK gates explicit-addon (Path 1 extension, 2026-05-28)
  // Tests inherit the outer describe's beforeEach mock setup.
  // ===================================================================

  function buildExplicitAddonRequest(bodyOverrides = {}) {
    return new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-token': 'token',
      },
      body: JSON.stringify({
        dryRun: true,
        offerType: 'addon',
        addOnCode: 'antioxidant_peel',
        now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York',
        sendStartHour: 9,
        sendEndHour: 17,
        candidates: [
          {
            firstName: 'Taylor',
            lastName: 'Guest',
            email: 'taylor@example.com',
          },
        ],
        ...bodyOverrides,
      }),
    });
  }

  function mockHappyAddonPath() {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-gate',
      phone: '+19175550001',
      tier: null,
      accountStatus: 'ACTIVE',
      firstName: 'Taylor',
      name: 'Taylor Guest',
      email: 'taylor@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'no_upgrade_target_for_duration',
      appointmentId: 'appt-gate',
      currentDurationMinutes: 50,
      availableGapMinutes: 10,
      startOn: '2026-03-09T18:00:00Z',
      isMember: false,
    });
  }

  it('with enableAddonFallback=false in body: explicit offerType=addon is blocked (no addon offer built)', async () => {
    mockHappyAddonPath();
    const res = await POST(buildExplicitAddonRequest({ enableAddonFallback: false }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].offerKind).not.toBe('addon');
    expect(body.results[0].status).toBe('skipped');
  });

  it('with SMS_ENABLE_ADDON_FALLBACK=false env: explicit offerType=addon is blocked (no addon offer built)', async () => {
    process.env.SMS_ENABLE_ADDON_FALLBACK = 'false';
    mockHappyAddonPath();
    const res = await POST(buildExplicitAddonRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].offerKind).not.toBe('addon');
    expect(body.results[0].status).toBe('skipped');
  });

  it('with SMS_ENABLE_ADDON_FALLBACK=false env: duration-only offer (no explicit offerType) still proceeds', async () => {
    process.env.SMS_ENABLE_ADDON_FALLBACK = 'false';
    mockLookupMember.mockResolvedValue({
      clientId: 'client-dur',
      phone: '+19175550002',
      tier: '30',
      hasMembership: true,
      accountStatus: 'ACTIVE',
      monthlyRate: 99,
      firstName: 'Casey',
      name: 'Casey Guest',
      email: 'casey@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-dur',
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
            firstName: 'Casey',
            lastName: 'Guest',
            email: 'casey@example.com',
            phone: '+19175550002',
          },
        ],
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    // Duration upgrade must NOT be gated by the addon path: it proceeds as a duration offer.
    expect(body.results[0].status).toBe('dry_run');
    expect(body.results[0].offerKind).toBe('duration');
  });

  it('with enableAddonFallback=true in body but env=false: addon stays blocked (kill switch cannot be bypassed by a request flag)', async () => {
    process.env.SMS_ENABLE_ADDON_FALLBACK = 'false'; // kill switch off
    mockHappyAddonPath();
    const res = await POST(buildExplicitAddonRequest({ enableAddonFallback: true })); // body flag must NOT re-enable
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].offerKind).not.toBe('addon');
    expect(body.results[0].status).toBe('skipped');
  });

  it('with SMS_ENABLE_ADDON_FALLBACK unset: addon is OFF (fail-closed default)', async () => {
    delete process.env.SMS_ENABLE_ADDON_FALLBACK;
    mockHappyAddonPath();
    const res = await POST(buildExplicitAddonRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].offerKind).not.toBe('addon');
    expect(body.results[0].status).toBe('skipped');
  });

  it('with SMS_ENABLE_ADDON_FALLBACK=true env: explicit offerType=addon builds the addon offer (Path 2 enabled path)', async () => {
    process.env.SMS_ENABLE_ADDON_FALLBACK = 'true';
    mockHappyAddonPath();
    const res = await POST(buildExplicitAddonRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('dry_run');
    expect(body.results[0].offerKind).toBe('addon');
  });

  it('quotes the member tier-aware delta in the offer and persists it', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1', phone: '+19175551234', tier: '30',
      hasMembership: true, accountStatus: 'ACTIVE', monthlyRate: 99,
      firstName: 'Debbie', name: 'Debbie Von Ahrens', email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-1', targetDurationMinutes: 50, currentDurationMinutes: 30,
      isMember: true, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      startOn: '2026-03-09T18:00:00Z',
    });
    mockSendTwilioSms.mockResolvedValue({ sid: 'SM123' });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
      body: JSON.stringify({
        dryRun: false, liveApproval: true, now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
        candidates: [{ firstName: 'Debbie', lastName: 'Von Ahrens', email: 'debbie@example.com', phone: '+1 (917) 555-1234' }],
      }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe('sent');
    expect(mockSendTwilioSms.mock.calls[0][0].body).toContain('for just $40 more');
    const persisted = mockSaveSession.mock.calls.at(-1)[0].pendingUpgradeOffer;
    expect(persisted.deltaDollars).toBe(40);
    expect(persisted.totalDollars).toBe(139);
    expect(persisted.isMember).toBe(true);
  });

  it('quotes the flat non-member delta in the offer', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-2', phone: '+19175551235', tier: null, hasMembership: false, accountStatus: null,
      firstName: 'Sam', name: 'Sam Doe', email: 'sam@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-2', targetDurationMinutes: 50, currentDurationMinutes: 30,
      isMember: false, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      startOn: '2026-03-09T18:00:00Z',
    });
    mockSendTwilioSms.mockResolvedValue({ sid: 'SM124' });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
      body: JSON.stringify({
        dryRun: false, liveApproval: true, now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
        candidates: [{ firstName: 'Sam', lastName: 'Doe', email: 'sam@example.com', phone: '+1 (917) 555-1235' }],
      }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(body.results[0].status).toBe('sent');
    expect(mockSendTwilioSms.mock.calls[0][0].body).toContain('for just $50 more');
    expect(mockSaveSession.mock.calls.at(-1)[0].pendingUpgradeOffer.deltaDollars).toBe(50);
  });

  it('skips the duration offer when a 30-min member rate is unresolvable', async () => {
    mockLookupMember.mockResolvedValue({
      clientId: 'client-3', phone: '+19175551236', tier: '30',
      hasMembership: true, accountStatus: 'ACTIVE', monthlyRate: null,
      firstName: 'Pat', name: 'Pat Roe', email: 'pat@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-3', targetDurationMinutes: 50, currentDurationMinutes: 30,
      isMember: true, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      startOn: '2026-03-09T18:00:00Z',
    });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
      body: JSON.stringify({
        dryRun: false, liveApproval: true, now: '2026-03-09T15:00:00Z',
        sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
        candidates: [{ firstName: 'Pat', lastName: 'Roe', email: 'pat@example.com', phone: '+1 (917) 555-1236' }],
      }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(body.results[0].status).toBe('skipped');
    expect(body.results[0].reason).toBe('duration_price_unresolved');
    expect(mockSendTwilioSms).not.toHaveBeenCalled();
  });

  it('reminder reuses the originally-quoted price instead of recomputing', async () => {
    // Profile now has monthlyRate: 79, so live resolver would produce deltaDollars: 60.
    // The original offer was quoted at deltaDollars: 40 (monthlyRate was 99 at send time).
    // On a reminder, the route must reuse 40, not recompute 60.
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1', phone: '+19175551234', tier: '30',
      hasMembership: true, accountStatus: 'ACTIVE', monthlyRate: 79,
      firstName: 'Debbie', name: 'Debbie Von Ahrens', email: 'debbie@example.com',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true, appointmentId: 'appt-1', targetDurationMinutes: 50, currentDurationMinutes: 30,
      isMember: true, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
      startOn: '2026-03-09T18:00:00Z',
    });
    // offerState has initialSentAt so hasPriorOffer is true and reminder window triggers.
    mockGetUpgradeOfferState.mockReturnValue({
      initialSentAt: '2026-03-09T12:00:00Z',
      reminderSentAt: null,
    });
    // Session carries the originally-quoted prices from the initial send.
    mockCreateSession.mockReturnValue({
      id: 'sess-1',
      status: 'active',
      pendingUpgradeOffer: {
        appointmentId: 'appt-1',
        createdAt: '2026-03-09T12:00:00Z',
        expiresAt: '2026-03-09T12:15:00Z',
        deltaDollars: 40,
        totalDollars: 139,
        isMember: true,
      },
    });
    mockSendTwilioSms.mockResolvedValue({ sid: 'SM-reminder-1' });

    const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
      body: JSON.stringify({
        dryRun: false, liveApproval: true,
        now: '2026-03-09T17:00:00Z',
        sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
        candidates: [{ firstName: 'Debbie', lastName: 'Von Ahrens', email: 'debbie@example.com', phone: '+1 (917) 555-1234' }],
      }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(body.results[0].status).toBe('sent');
    expect(body.results[0].offerType).toBe('reminder');
    // deltaDollars must be 40 (original), NOT 60 (what live resolver would return for monthlyRate 79).
    const persisted = mockSaveSession.mock.calls.at(-1)[0].pendingUpgradeOffer;
    expect(persisted.deltaDollars).toBe(40);
    expect(persisted.totalDollars).toBe(139);
    expect(persisted.isMember).toBe(true);
  });
});
