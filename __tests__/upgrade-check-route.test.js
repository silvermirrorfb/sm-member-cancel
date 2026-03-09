import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: (...args) => mockLookupMember(...args),
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
}));

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
  getClientIP: () => '127.0.0.1',
}));

import { POST } from '../src/app/api/qa/upgrade-check/route.js';

describe('QA upgrade-check route', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 401 when token is configured but missing', async () => {
    process.env.QA_UPGRADE_CHECK_TOKEN = 'secret-token';
    process.env.NODE_ENV = 'production';

    const req = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 for missing required fields', async () => {
    process.env.NODE_ENV = 'development';

    const req = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'Jane' }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain('firstName, lastName');
  });

  it('returns successful read-only opportunity payload', async () => {
    process.env.NODE_ENV = 'development';
    mockLookupMember.mockResolvedValue({
      name: 'Jane Smith',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '15555550123',
      clientId: 'client-1',
      tier: '30',
      accountStatus: 'active',
      location: 'Flatiron',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      reason: 'eligible',
      appointmentId: 'appt-1',
      targetDurationMinutes: 50,
      requiredExtraMinutes: 20,
      availableGapMinutes: 25,
    });

    const req = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        now: '2026-03-09T14:00:00.000Z',
        windowHours: 6,
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.member.name).toBe('Jane Smith');
    expect(body.qa.readOnly).toBe(true);
    expect(body.opportunity.eligible).toBe(true);
    expect(mockLookupMember).toHaveBeenCalledWith('Jane Smith', 'jane@example.com');
    expect(mockEvaluateUpgradeOpportunityForProfile).toHaveBeenCalled();
  });

  it('includes diagnostics only when debug=true', async () => {
    process.env.NODE_ENV = 'development';
    mockLookupMember.mockResolvedValue({
      name: 'Jane Smith',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '15555550123',
      clientId: 'client-1',
      tier: '30',
      accountStatus: 'active',
      location: 'Flatiron',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'appointment_scan_failed',
      diagnostics: { failure: 'appointments_query_failed' },
    });

    const debugReq = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        debug: true,
      }),
    });
    const debugRes = await POST(debugReq);
    const debugBody = await debugRes.json();
    expect(debugBody.qa.debug).toBe(true);
    expect(debugBody.opportunity.diagnostics.failure).toBe('appointments_query_failed');

    const normalReq = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
      }),
    });
    const normalRes = await POST(normalReq);
    const normalBody = await normalRes.json();
    expect(normalBody.qa.debug).toBe(false);
    expect(normalBody.opportunity.diagnostics).toBeUndefined();
  });
});
