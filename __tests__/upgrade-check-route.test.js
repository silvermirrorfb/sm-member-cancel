import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLookupMember = vi.fn();
const mockEvaluateUpgradeOpportunityForProfile = vi.fn();
const mockEvaluateUpgradeEligibilityFromAppointments = vi.fn();
const mockResolveNameScanFallbackCandidate = vi.fn();
const mockBuildProfile = vi.fn();

vi.mock('../src/lib/boulevard.js', () => ({
  lookupMember: (...args) => mockLookupMember(...args),
  evaluateUpgradeOpportunityForProfile: (...args) => mockEvaluateUpgradeOpportunityForProfile(...args),
  evaluateUpgradeEligibilityFromAppointments: (...args) => mockEvaluateUpgradeEligibilityFromAppointments(...args),
  resolveNameScanFallbackCandidate: (...args) => mockResolveNameScanFallbackCandidate(...args),
  buildProfile: (...args) => mockBuildProfile(...args),
}));

vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, remaining: 39, retryAfterMs: 0 }),
  getClientIP: () => '127.0.0.1',
}));

import { POST } from '../src/app/api/qa/upgrade-check/route.js';

describe('QA upgrade-check route', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    mockBuildProfile.mockImplementation(input => input);
    mockResolveNameScanFallbackCandidate.mockReturnValue({ candidate: null, strategy: null, reason: 'no_match' });
    mockEvaluateUpgradeEligibilityFromAppointments.mockReturnValue({ eligible: false, reason: 'synthetic_default' });
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
    expect(Boolean(body.requestId)).toBe(true);
    expect(body.member.name).toBe('Jane Smith');
    expect(body.qa.readOnly).toBe(true);
    expect(body.opportunity.eligible).toBe(true);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    expect(mockLookupMember).toHaveBeenCalledWith(
      'Jane Smith',
      'jane@example.com',
      expect.objectContaining({ preferLocationId: undefined }),
    );
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

  it('passes optional locationId override through to opportunity evaluation', async () => {
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
      locationId: 'loc-profile',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: false,
      reason: 'no_upcoming_appointment_in_window',
    });

    const req = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        locationId: '24a2fac0-deef-4f7f-8bf6-52368be42d65',
      }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.qa.locationId).toBe('24a2fac0-deef-4f7f-8bf6-52368be42d65');
    expect(body.qa.resolvedLocationId).toBe('urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65');
    expect(mockEvaluateUpgradeOpportunityForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1' }),
      expect.objectContaining({ locationId: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65' }),
    );
  });

  it('replays identical request when idempotency key is reused', async () => {
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
    });

    const headers = {
      'content-type': 'application/json',
      'x-idempotency-key': 'qa-idempotency-1',
      'x-request-id': 'trace-1',
    };
    const body = JSON.stringify({
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@example.com',
    });

    const firstRes = await POST(new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers,
      body,
    }));
    const firstJson = await firstRes.json();
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get('x-idempotency-replayed')).toBe('false');

    const secondRes = await POST(new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: { ...headers, 'x-request-id': 'trace-2' },
      body,
    }));
    const secondJson = await secondRes.json();

    expect(secondRes.status).toBe(200);
    expect(secondRes.headers.get('x-idempotency-replayed')).toBe('true');
    expect(firstJson.opportunity).toEqual(secondJson.opportunity);
    expect(mockEvaluateUpgradeOpportunityForProfile).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when idempotency key is reused with a different payload', async () => {
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
    });

    const headers = {
      'content-type': 'application/json',
      'x-idempotency-key': 'qa-idempotency-2',
    };

    const firstRes = await POST(new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
      }),
    }));
    expect(firstRes.status).toBe(200);

    const secondRes = await POST(new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        debug: true,
      }),
    }));
    const secondBody = await secondRes.json();
    expect(secondRes.status).toBe(409);
    expect(secondBody.error).toContain('Idempotency key');
  });

  it('supports synthetic eligibility mode without Boulevard lookup', async () => {
    process.env.NODE_ENV = 'development';
    mockBuildProfile.mockReturnValue({
      name: 'Synthetic Member',
      firstName: 'Synthetic',
      clientId: 'client-synth',
      location: 'Upper West Side',
      locationId: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65',
      locationCanonicalId: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65',
    });
    mockEvaluateUpgradeEligibilityFromAppointments.mockReturnValue({
      eligible: true,
      reason: 'eligible',
      availableGapMinutes: 30,
    });

    const req = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qa-synthetic-token': 'dev-ok',
      },
      body: JSON.stringify({
        syntheticMode: 'eligibility',
        syntheticProfile: {
          name: 'Synthetic Member',
          firstName: 'Synthetic',
          clientId: 'client-synth',
        },
        syntheticAppointments: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.qa.syntheticMode).toBe('eligibility');
    expect(body.qa.synthetic).toBe(true);
    expect(body.opportunity.eligible).toBe(true);
    expect(mockLookupMember).not.toHaveBeenCalled();
    expect(mockEvaluateUpgradeEligibilityFromAppointments).toHaveBeenCalledTimes(1);
  });

  it('supports synthetic lookup mode with fallback resolver output', async () => {
    process.env.NODE_ENV = 'development';
    mockResolveNameScanFallbackCandidate.mockReturnValue({
      candidate: {
        id: 'client-1',
        firstName: 'Sandra',
        lastName: 'Bellew',
        email: 'sandra@example.com',
        primaryLocation: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65' },
      },
      strategy: 'name_scan_exact',
      reason: null,
    });

    const req = new Request('http://localhost/api/qa/upgrade-check', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qa-synthetic-token': 'dev-ok',
      },
      body: JSON.stringify({
        syntheticMode: 'lookup',
        firstName: 'Sandra',
        lastName: 'Bellew',
        email: 'stale-email@example.com',
        syntheticCandidates: [{ id: 'client-1' }],
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.qa.syntheticMode).toBe('lookup');
    expect(body.syntheticLookup.matched).toBe(true);
    expect(body.syntheticLookup.strategy).toBe('name_scan_exact');
    expect(mockResolveNameScanFallbackCandidate).toHaveBeenCalledTimes(1);
    expect(mockLookupMember).not.toHaveBeenCalled();
  });
});
