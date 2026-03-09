import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockBuildSystemPromptWithProfile = vi.fn();
const mockFormatProfileForPrompt = vi.fn();
const mockBindPhoneToSession = vi.fn();
const mockGetSessionIdForPhone = vi.fn();
const mockSendTwilioSms = vi.fn();

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: (...args) => mockLookupMember(...args),
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
  formatProfileForPrompt: (...args) => mockFormatProfileForPrompt(...args),
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
}));

vi.mock('../src/lib/twilio.js', () => ({
  sendTwilioSms: (...args) => mockSendTwilioSms(...args),
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
  });

  it('skips all candidates outside send window before lookups', async () => {
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
    expect(body.results[0].reason).toBe('outside_send_window');
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
});
