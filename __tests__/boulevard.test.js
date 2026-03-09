import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  lookupMember,
  normalizePhone,
  verifyMemberIdentity,
  levenshtein,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  evaluateUpgradeEligibilityFromAppointments,
  evaluateUpgradeOpportunityForProfile,
  __resetBoulevardCachesForTests,
} from '../src/lib/boulevard.js';

describe('normalizePhone', () => {
  it('strips non-digits and adds US country code', () => {
    expect(normalizePhone('(470) 428-5700')).toBe('14704285700');
  });

  it('keeps 11-digit numbers as-is', () => {
    expect(normalizePhone('14704285700')).toBe('14704285700');
  });

  it('returns empty string for null/empty', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('sophia dowd', 'sophia dowd')).toBe(0);
  });

  it('returns correct distance for small edits', () => {
    expect(levenshtein('sophia', 'sofhia')).toBeLessThanOrEqual(2);
  });

  it('returns correct distance for different strings', () => {
    expect(levenshtein('sophia', 'matthew')).toBeGreaterThan(3);
  });
});

describe('verifyMemberIdentity (P1-1)', () => {
  const validProfile = {
    name: 'Sophia Dowd',
    email: 'sophia@test.com',
    phone: '(470) 428-5700',
  };

  it('verifies matching name + email', () => {
    const request = { firstName: 'Sophia', lastName: 'Dowd', email: 'sophia@test.com' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(true);
  });

  it('verifies matching name + phone', () => {
    const request = { firstName: 'Sophia', lastName: 'Dowd', phone: '470-428-5700' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(true);
  });

  it('allows fuzzy name match (within levenshtein 3)', () => {
    const request = { firstName: 'Sofia', lastName: 'Dowd', email: 'sophia@test.com' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(true);
  });

  it('rejects name mismatch', () => {
    const request = { firstName: 'John', lastName: 'Smith', email: 'sophia@test.com' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(false);
  });

  it('rejects contact mismatch', () => {
    const request = { firstName: 'Sophia', lastName: 'Dowd', email: 'wrong@test.com', phone: '111-222-3333' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(false);
  });

  it('rejects null inputs', () => {
    expect(verifyMemberIdentity(null, validProfile)).toBe(false);
    expect(verifyMemberIdentity({}, null)).toBe(false);
  });
});

describe('P1-2: Mock fallback gating', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('lookupMember returns null when API key missing in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BOULEVARD_API_KEY;

    // Dynamic import to get fresh module with updated env
    const { lookupMember } = await import('../src/lib/boulevard.js');
    const result = await lookupMember('Test User', 'test@test.com');
    expect(result).toBeNull();
  });
});

describe('lookupMember fallback matching', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    };
    __resetBoulevardCachesForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('falls back to unique exact-name scan when email lookup returns no rows', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('FindClientByEmail')) {
        return { ok: true, json: async () => ({ data: { clients: { edges: [] } } }) };
      }
      if (body.query.includes('FindClientsByNameScan')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              clients: {
                edges: [{
                  node: {
                    id: 'client-1',
                    firstName: 'Sandra',
                    lastName: 'Bellew',
                    email: 'sandra.bellew@silvermirror.com',
                    mobilePhone: null,
                    createdAt: '2024-01-01T00:00:00.000Z',
                    appointmentCount: 3,
                    active: true,
                    primaryLocation: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Upper West Side' },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (body.query.includes('FindMembershipForClient')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              memberships: {
                edges: [{
                  node: {
                    id: 'mem-1',
                    clientId: 'client-1',
                    name: '50-minute membership',
                    startOn: '2025-01-01',
                    status: 'ACTIVE',
                    termNumber: 1,
                    unitPrice: 13900,
                    nextChargeDate: '2026-04-01',
                    location: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Upper West Side' },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (body.query.includes('IntrospectType')) {
        return { ok: true, json: async () => ({ data: { __type: null } }) };
      }
      return { ok: true, json: async () => ({ data: {} }) };
    });

    const result = await lookupMember('Sandra Bellew', 'stale-email@example.com');
    expect(result).not.toBeNull();
    expect(result.clientId).toBe('client-1');
    expect(result.lookupStrategy).toBe('name_scan_exact');
  });

  it('prefers location-matching candidate when duplicate name/email records exist', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('FindClientByEmail')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              clients: {
                edges: [
                  {
                    node: {
                      id: 'client-old',
                      firstName: 'Matt',
                      lastName: 'Maroone',
                      email: 'mattmaroone@gmail.com',
                      mobilePhone: '+12134401333',
                      createdAt: '2020-01-01T00:00:00.000Z',
                      appointmentCount: 1,
                      active: false,
                      primaryLocation: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Brickell' },
                    },
                  },
                  {
                    node: {
                      id: 'client-pq',
                      firstName: 'Matt',
                      lastName: 'Maroone',
                      email: 'mattmaroone@gmail.com',
                      mobilePhone: '+12134401333',
                      createdAt: '2026-01-01T00:00:00.000Z',
                      appointmentCount: 27,
                      active: true,
                      primaryLocation: { id: 'urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc', name: 'Penn Quarter' },
                    },
                  },
                ],
              },
            },
          }),
        };
      }
      if (body.query.includes('FindMembershipForClient')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              memberships: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (body.query.includes('IntrospectType')) {
        return { ok: true, json: async () => ({ data: { __type: null } }) };
      }
      return { ok: true, json: async () => ({ data: {} }) };
    });

    const result = await lookupMember('Matt Maroone', 'mattmaroone@gmail.com', {
      preferLocationId: 'urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc',
    });
    expect(result).not.toBeNull();
    expect(result.clientId).toBe('client-pq');
    expect(result.location).toBe('Penn Quarter');
  });
});

describe('constants', () => {
  it('WALKIN_PRICES has expected tiers', () => {
    expect(WALKIN_PRICES['30']).toBe(119);
    expect(WALKIN_PRICES['50']).toBe(169);
    expect(WALKIN_PRICES['90']).toBe(279);
  });

  it('PERKS are sorted by month', () => {
    for (let i = 1; i < PERKS.length; i++) {
      expect(PERKS[i].month).toBeGreaterThan(PERKS[i - 1].month);
    }
  });
});

describe('upgrade eligibility engine', () => {
  const profile = {
    clientId: 'client-1',
    tier: '30',
    accountStatus: 'active',
  };

  it('marks 30->50 upgrade eligible when provider gap is sufficient', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:10:00.000Z',
        endOn: '2026-03-08T11:40:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.currentDurationMinutes).toBe(30);
    expect(result.targetDurationMinutes).toBe(50);
    expect(result.requiredExtraMinutes).toBe(20);
    expect(result.availableGapMinutes).toBe(25);
    expect(result.pricing.memberDelta).toBe(40);
  });

  it('marks upgrade ineligible when provider gap is too small', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:00:00.000Z',
        endOn: '2026-03-08T11:30:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.availableGapMinutes).toBe(15);
  });

  it('treats exactly 20 minutes of post-prep gap as eligible for 30->50', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:05:00.000Z',
        endOn: '2026-03-08T11:35:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.availableGapMinutes).toBe(20);
    expect(result.requiredExtraMinutes).toBe(20);
  });

  it('treats 19 minutes of post-prep gap as ineligible for 30->50', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:04:00.000Z',
        endOn: '2026-03-08T11:34:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.availableGapMinutes).toBe(19);
  });

  it('treats no next provider commitment as unlimited gap', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:50:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, {
      ...profile,
      tier: '50',
    }, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.currentDurationMinutes).toBe(50);
    expect(result.targetDurationMinutes).toBe(90);
    expect(result.gapUnlimited).toBe(true);
    expect(result.availableGapMinutes).toBeNull();
    expect(result.pricing.memberDelta).toBe(60);
  });

  it('ignores canceled and no-show entries when selecting next provider commitment', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:50:00.000Z',
        endOn: '2026-03-08T11:20:00.000Z',
        status: 'CANCELED',
      },
      {
        id: 'appt-3',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:55:00.000Z',
        endOn: '2026-03-08T11:25:00.000Z',
        status: 'NO_SHOW',
      },
      {
        id: 'appt-4',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:20:00.000Z',
        endOn: '2026-03-08T11:50:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.nextCommitmentStartOn).toBe('2026-03-08T11:20:00.000Z');
    expect(result.availableGapMinutes).toBe(35);
  });

  it('uses non-member pricing for inactive/canceled accounts', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:05:00.000Z',
        endOn: '2026-03-08T11:35:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, {
      clientId: 'client-1',
      tier: '30',
      accountStatus: 'inactive',
    }, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.isMember).toBe(false);
    expect(result.pricing.offeredDelta).toBe(50);
    expect(result.pricing.offeredTotal).toBe(169);
  });

  it('handles duplicate provider commitments at the same timestamp deterministically', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'dup-a',
        clientId: 'other-a',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:05:00.000Z',
        endOn: '2026-03-08T11:35:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'dup-b',
        clientId: 'other-b',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:05:00.000Z',
        endOn: '2026-03-08T11:35:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.availableGapMinutes).toBe(20);
    expect(result.nextCommitmentStartOn).toBe('2026-03-08T11:05:00.000Z');
  });

  it('falls back to conservative location-based gap when provider id is unavailable', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: '',
        locationId: 'loc-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-x',
        locationId: 'loc-1',
        startOn: '2026-03-08T11:05:00.000Z',
        endOn: '2026-03-08T11:35:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.providerIdentityMode).toBe('fallback_no_provider_id');
    expect(result.availableGapMinutes).toBe(20);
  });

  it('treats aliased location IDs as equivalent when provider identity is unavailable', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: '',
        locationId: 'urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-x',
        locationId: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65',
        startOn: '2026-03-08T11:05:00.000Z',
        endOn: '2026-03-08T11:35:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.locationCanonicalId).toBe('urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65');
    expect(result.availableGapMinutes).toBe(20);
  });
});

describe('upgrade opportunity Boulevard integration (mocked)', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    };
    __resetBoulevardCachesForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('scans appointments and returns eligible opportunity', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('IntrospectType')) {
        const typeName = body?.variables?.typeName;
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'appointments' },
                  ],
                },
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              __type: {
                fields: [
                  { name: 'id' },
                  { name: 'startOn' },
                  { name: 'endOn' },
                  { name: 'clientId' },
                  { name: 'providerId' },
                  { name: 'status' },
                  { name: 'canceledAt' },
                ],
              },
            },
          }),
        };
      }

      if (body.query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      providerId: 'prov-1',
                      startOn: '2026-03-08T10:00:00.000Z',
                      endOn: '2026-03-08T10:30:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      clientId: 'other',
                      providerId: 'prov-1',
                      startOn: '2026-03-08T11:10:00.000Z',
                      endOn: '2026-03-08T11:40:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.appointmentId).toBe('appt-1');
    expect(result.targetDurationMinutes).toBe(50);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('falls back to hardcoded query roots when Query introspection is unavailable', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('IntrospectType')) {
        const typeName = body?.variables?.typeName;
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: null,
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              __type: {
                fields: [
                  { name: 'id' },
                  { name: 'startOn' },
                  { name: 'endOn' },
                  { name: 'clientId' },
                  { name: 'providerId' },
                  { name: 'status' },
                  { name: 'canceledAt' },
                ],
              },
            },
          }),
        };
      }

      if (body.query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      providerId: 'prov-1',
                      startOn: '2026-03-08T10:00:00.000Z',
                      endOn: '2026-03-08T10:30:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
  });

  it('supports alternative appointment field names with nested client/provider objects', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('IntrospectType')) {
        const typeName = body?.variables?.typeName;
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'appointments' }],
                },
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              __type: {
                fields: [
                  { name: 'id' },
                  { name: 'startAt' },
                  { name: 'endAt' },
                  { name: 'client' },
                  { name: 'provider' },
                  { name: 'status' },
                ],
              },
            },
          }),
        };
      }

      if (body.query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      client: { id: 'client-1' },
                      provider: { id: 'prov-1' },
                      startAt: '2026-03-08T10:00:00.000Z',
                      endAt: '2026-03-08T10:30:00.000Z',
                      status: 'BOOKED',
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      client: { id: 'other' },
                      provider: { id: 'prov-1' },
                      startAt: '2026-03-08T11:10:00.000Z',
                      endAt: '2026-03-08T11:40:00.000Z',
                      status: 'BOOKED',
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.appointmentId).toBe('appt-1');
    expect(result.availableGapMinutes).toBe(25);
  });

  it('derives provider identity from appointmentServices when provider fields are nested', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    const objectType = (name) => ({ kind: 'OBJECT', name, ofType: null });
    const listOfObjectType = (name) => ({
      kind: 'LIST',
      name: null,
      ofType: { kind: 'OBJECT', name, ofType: null },
    });
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('IntrospectType')) {
        const typeName = body?.variables?.typeName;
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'appointments', type: listOfObjectType('AppointmentConnection') }],
                },
              },
            }),
          };
        }
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'id', type: scalarType('ID') },
                    { name: 'startAt', type: scalarType('DateTime') },
                    { name: 'endAt', type: scalarType('DateTime') },
                    { name: 'clientId', type: scalarType('ID') },
                    { name: 'appointmentServices', type: objectType('AppointmentServiceConnection') },
                    { name: 'state', type: scalarType('AppointmentState') },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentServiceConnection') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'edges', type: listOfObjectType('AppointmentServiceEdge') }],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentServiceEdge') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'node', type: objectType('AppointmentService') }],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentService') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'staffId', type: scalarType('ID') }],
                },
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ data: { __type: null } }),
        };
      }

      if (body.query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      startAt: '2026-03-08T10:00:00.000Z',
                      endAt: '2026-03-08T10:30:00.000Z',
                      state: 'BOOKED',
                      appointmentServices: {
                        edges: [
                          { node: { staffId: 'prov-1' } },
                        ],
                      },
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      clientId: 'other',
                      startAt: '2026-03-08T11:10:00.000Z',
                      endAt: '2026-03-08T11:40:00.000Z',
                      state: 'BOOKED',
                      appointmentServices: {
                        edges: [
                          { node: { staffId: 'prov-1' } },
                        ],
                      },
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.providerId).toBe('prov-1');
    expect(result.appointmentId).toBe('appt-1');
  });

  it('falls back to no-arg strategy when appointments rejects cursor args', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    const objectType = (name) => ({ kind: 'OBJECT', name, ofType: null });

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectSchemaQueryType')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              __schema: {
                queryType: { name: 'RootQueryType' },
              },
            },
          }),
        };
      }

      if (body.query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'RootQueryType') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'appointments',
                      type: objectType('AppointmentConnection'),
                    },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentConnection') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'edges', args: [], type: objectType('AppointmentEdge') },
                    { name: 'pageInfo', type: objectType('PageInfo') },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({ data: { __type: null } }),
          };
        }
      }

      if (body.query.includes('IntrospectType')) {
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({ data: { __type: null } }),
          };
        }
        if (typeName === 'RootQueryType') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'appointments' }],
                },
              },
            }),
          };
        }
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'id', type: scalarType('ID') },
                    { name: 'startAt', type: scalarType('DateTime') },
                    { name: 'endAt', type: scalarType('DateTime') },
                    { name: 'clientId', type: scalarType('ID') },
                    { name: 'providerId', type: scalarType('ID') },
                    { name: 'state', type: scalarType('AppointmentState') },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentConnection') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'edges' }, { name: 'pageInfo' }],
                },
              },
            }),
          };
        }
      }

      if (body.query.includes('ScanAppointments') && body.query.includes('appointments(first:')) {
        return {
          ok: true,
          json: async () => ({
            errors: [{ message: 'Unknown argument "first" on field "RootQueryType.appointments".' }],
          }),
        };
      }

      if (body.query.includes('ScanAppointments') && body.query.includes('appointments {')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      providerId: 'prov-1',
                      startAt: '2026-03-08T10:00:00.000Z',
                      endAt: '2026-03-08T10:30:00.000Z',
                      state: 'BOOKED',
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      clientId: 'other',
                      providerId: 'prov-1',
                      startAt: '2026-03-08T11:10:00.000Z',
                      endAt: '2026-03-08T11:40:00.000Z',
                      state: 'BOOKED',
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    const scanQueries = global.fetch.mock.calls
      .map(call => JSON.parse(call[1].body).query)
      .filter(query => query.includes('ScanAppointments'));
    expect(scanQueries.some(query => query.includes('appointments(first:'))).toBe(true);
    expect(scanQueries.some(query => query.includes('appointments {'))).toBe(true);
  });

  it('returns per-root query diagnostics when all appointment scan strategies fail', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectSchemaQueryType')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              __schema: {
                queryType: { name: 'RootQueryType' },
              },
            },
          }),
        };
      }

      if (body.query.includes('IntrospectType')) {
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({ data: { __type: null } }),
          };
        }
        if (typeName === 'RootQueryType') {
          return {
            ok: true,
            json: async () => ({ data: { __type: null } }),
          };
        }
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'id' },
                    { name: 'startOn' },
                    { name: 'endOn' },
                    { name: 'clientId' },
                    { name: 'providerId' },
                  ],
                },
              },
            }),
          };
        }
      }

      if (body.query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({
            errors: [{ message: 'forced test failure' }],
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('appointment_scan_failed');
    expect(result.diagnostics?.failure).toBe('appointments_query_failed');
    expect(result.diagnostics?.queryRootTried).toEqual(['appointments', 'bookings', 'calendarAppointments']);
    const rootsWithErrors = new Set((result.diagnostics?.queryErrors || []).map(err => err.root));
    expect(rootsWithErrors.has('appointments')).toBe(true);
    expect(rootsWithErrors.has('bookings')).toBe(true);
    expect(rootsWithErrors.has('calendarAppointments')).toBe(true);
  });

  it('passes required locationId argument when appointments root requires it', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    const objectType = (name) => ({ kind: 'OBJECT', name, ofType: null });
    const nonNullType = (inner) => ({ kind: 'NON_NULL', name: null, ofType: inner });

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectSchemaQueryType')) {
        return {
          ok: true,
          json: async () => ({ data: { __schema: { queryType: { name: 'RootQueryType' } } } }),
        };
      }

      if (body.query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'RootQueryType') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'appointments',
                      args: [
                        { name: 'locationId', type: nonNullType(scalarType('ID')) },
                        { name: 'first', type: scalarType('Int') },
                      ],
                      type: objectType('AppointmentConnection'),
                    },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentConnection') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'edges', type: objectType('AppointmentEdge') }, { name: 'pageInfo', type: objectType('PageInfo') }],
                },
              },
            }),
          };
        }
        if (typeName === 'Query') {
          return { ok: true, json: async () => ({ data: { __type: null } }) };
        }
      }

      if (body.query.includes('IntrospectType')) {
        if (typeName === 'Query') {
          return { ok: true, json: async () => ({ data: { __type: null } }) };
        }
        if (typeName === 'RootQueryType') {
          return { ok: true, json: async () => ({ data: { __type: { fields: [{ name: 'appointments' }] } } }) };
        }
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'id', type: scalarType('ID') },
                    { name: 'startAt', type: scalarType('DateTime') },
                    { name: 'endAt', type: scalarType('DateTime') },
                    { name: 'clientId', type: scalarType('ID') },
                    { name: 'providerId', type: scalarType('ID') },
                    { name: 'state', type: scalarType('AppointmentState') },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentConnection') {
          return { ok: true, json: async () => ({ data: { __type: { fields: [{ name: 'edges' }, { name: 'pageInfo' }] } } }) };
        }
      }

      if (body.query.includes('ScanAppointments')) {
        expect(body.variables?.locationId).toBe('urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65');
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      providerId: 'prov-1',
                      startAt: '2026-03-08T10:00:00.000Z',
                      endAt: '2026-03-08T10:30:00.000Z',
                      state: 'BOOKED',
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      clientId: 'other',
                      providerId: 'prov-1',
                      startAt: '2026-03-08T11:10:00.000Z',
                      endAt: '2026-03-08T11:40:00.000Z',
                      state: 'BOOKED',
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }

      return { ok: true, json: async () => ({ data: {} }) };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', locationId: '24a2fac0-deef-4f7f-8bf6-52368be42d65', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
  });

  it('falls back to unscoped appointment scan when location-scoped scan returns zero rows', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    const objectType = (name) => ({ kind: 'OBJECT', name, ofType: null });

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectSchemaQueryType')) {
        return {
          ok: true,
          json: async () => ({ data: { __schema: { queryType: { name: 'RootQueryType' } } } }),
        };
      }

      if (body.query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'RootQueryType') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'appointments',
                      args: [
                        { name: 'locationId', type: scalarType('ID') },
                        { name: 'first', type: scalarType('Int') },
                      ],
                      type: objectType('AppointmentConnection'),
                    },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'AppointmentConnection') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'edges', type: objectType('AppointmentEdge') }, { name: 'pageInfo', type: objectType('PageInfo') }],
                },
              },
            }),
          };
        }
      }

      if (body.query.includes('IntrospectType')) {
        if (typeName === 'Query') return { ok: true, json: async () => ({ data: { __type: null } }) };
        if (typeName === 'RootQueryType') return { ok: true, json: async () => ({ data: { __type: { fields: [{ name: 'appointments' }] } } }) };
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'id', type: scalarType('ID') },
                    { name: 'startAt', type: scalarType('DateTime') },
                    { name: 'endAt', type: scalarType('DateTime') },
                    { name: 'clientId', type: scalarType('ID') },
                    { name: 'providerId', type: scalarType('ID') },
                    { name: 'state', type: scalarType('AppointmentState') },
                    { name: 'locationId', type: scalarType('ID') },
                  ],
                },
              },
            }),
          };
        }
      }

      if (body.query.includes('ScanAppointments')) {
        const scoped = body.variables?.locationId === 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65';
        if (scoped) {
          return {
            ok: true,
            json: async () => ({
              data: {
                appointments: {
                  edges: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      providerId: 'prov-1',
                      locationId: 'urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc',
                      startAt: '2026-03-08T10:00:00.000Z',
                      endAt: '2026-03-08T10:30:00.000Z',
                      state: 'BOOKED',
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      clientId: 'other',
                      providerId: 'prov-1',
                      locationId: 'urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc',
                      startAt: '2026-03-08T11:10:00.000Z',
                      endAt: '2026-03-08T11:40:00.000Z',
                      state: 'BOOKED',
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }

      return { ok: true, json: async () => ({ data: {} }) };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', locationId: '24a2fac0-deef-4f7f-8bf6-52368be42d65', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.locationFallbackUsed).toBe(true);
  });

  it('reports preflight error when required locationId arg is missing', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    const objectType = (name) => ({ kind: 'OBJECT', name, ofType: null });
    const nonNullType = (inner) => ({ kind: 'NON_NULL', name: null, ofType: inner });

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectSchemaQueryType')) {
        return {
          ok: true,
          json: async () => ({ data: { __schema: { queryType: { name: 'RootQueryType' } } } }),
        };
      }

      if (body.query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'RootQueryType') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'appointments',
                      args: [{ name: 'locationId', type: nonNullType(scalarType('ID')) }],
                      type: objectType('AppointmentConnection'),
                    },
                  ],
                },
              },
            }),
          };
        }
        if (typeName === 'Query') return { ok: true, json: async () => ({ data: { __type: null } }) };
      }

      if (body.query.includes('IntrospectType')) {
        if (typeName === 'Query') return { ok: true, json: async () => ({ data: { __type: null } }) };
        if (typeName === 'RootQueryType') return { ok: true, json: async () => ({ data: { __type: { fields: [{ name: 'appointments' }] } } }) };
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [{ name: 'id' }, { name: 'startAt' }, { name: 'endAt' }, { name: 'clientId' }],
                },
              },
            }),
          };
        }
      }

      if (body.query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({ errors: [{ message: 'should not execute scan query when required args missing' }] }),
        };
      }

      return { ok: true, json: async () => ({ data: {} }) };
    });

    const result = await evaluateUpgradeOpportunityForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('appointment_scan_failed');
    expect(result.diagnostics?.failure).toBe('appointments_query_failed');
    expect(result.diagnostics?.queryErrors?.[0]?.stage).toBe('preflight');
    expect(result.diagnostics?.queryErrors?.[0]?.errors?.[0]?.code).toBe('MISSING_REQUIRED_QUERY_ARG');
  });
});
