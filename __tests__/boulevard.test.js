import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  lookupMember,
  normalizePhone,
  normalizeBoulevardLocationId,
  resolveBoulevardLocationInput,
  verifyMemberIdentity,
  levenshtein,
  OFFICIAL_LOCATION_REGISTRY,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
  computeValues,
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

describe('computeValues', () => {
  it('treats zero-rate internal accounts like unknown-rate accounts for savings', () => {
    const computed = computeValues({
      tier: '50',
      monthlyRate: 0,
      facialsRedeemed: 12,
      totalDuesPaid: 0,
      totalRetailPurchases: 0,
      totalAddonPurchases: 0,
      loyaltyEnrolled: false,
      loyaltyPoints: null,
      tenureMonths: 2,
      unusedCredits: 0,
    });

    expect(computed.rateDiff).toBeNull();
    expect(computed.rateLockAnnual).toBeNull();
    expect(computed.walkinSavings).toBeNull();
  });
});

describe('location registry and normalization', () => {
  it('defines exactly 10 canonical storefront locations', () => {
    expect(Array.isArray(OFFICIAL_LOCATION_REGISTRY)).toBe(true);
    expect(OFFICIAL_LOCATION_REGISTRY).toHaveLength(10);
    const ids = new Set(OFFICIAL_LOCATION_REGISTRY.map(entry => entry.id));
    expect(ids.size).toBe(10);
  });

  it('remaps known legacy Penn Quarter ID to the canonical ID', () => {
    const normalized = normalizeBoulevardLocationId('urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc');
    expect(normalized).toBe('urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa');
  });

  it('resolves location names and short aliases to canonical IDs', () => {
    expect(normalizeBoulevardLocationId('Penn Quarter')).toBe('urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa');
    expect(normalizeBoulevardLocationId('uws')).toBe('urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb');
  });

  it('fails safe for unknown plain-text location overrides', () => {
    const resolved = resolveBoulevardLocationInput('Made Up Storefront');
    expect(resolved.locationId).toBe('');
    expect(resolved.official).toBe(false);
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
                    primaryLocation: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Brickell' },
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
                    location: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Brickell' },
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
                      primaryLocation: { id: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', name: 'Penn Quarter' },
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
      preferLocationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
    });
    expect(result).not.toBeNull();
    expect(result.clientId).toBe('client-pq');
    expect(result.location).toBe('Penn Quarter');
  });
});

describe('lookupMember log redaction', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let consoleLogSpy;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    };
    __resetBoulevardCachesForTests();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('redacts raw email addresses and names in lookup logs', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('FindClientByEmail')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              clients: {
                edges: [{
                  node: {
                    id: 'client-1',
                    firstName: 'Sophia',
                    lastName: 'Dowd',
                    email: 'sophia.secret@test.com',
                    mobilePhone: '+14704285700',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    appointmentCount: 3,
                    active: true,
                    primaryLocation: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Brickell' },
                  },
                }],
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

    const result = await lookupMember('Sophia Dowd', 'sophia.secret@test.com');
    expect(result?.clientId).toBe('client-1');

    const logOutput = consoleLogSpy.mock.calls.map(args => args.join(' ')).join(' ');
    expect(logOutput).toContain('s***@test.com');
    expect(logOutput).not.toContain('sophia.secret@test.com');
    expect(logOutput).not.toContain('Sophia Dowd');
  });

  it('redacts raw phone numbers and names in lookup logs', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('FindClientsByPhoneScan')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              clients: {
                edges: [{
                  node: {
                    id: 'client-1',
                    firstName: 'Sophia',
                    lastName: 'Dowd',
                    email: 'sophia.secret@test.com',
                    mobilePhone: '+14704285700',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    appointmentCount: 3,
                    active: true,
                    primaryLocation: { id: 'urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65', name: 'Brickell' },
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

    const result = await lookupMember('Sophia Dowd', '470-428-5700');
    expect(result?.clientId).toBe('client-1');

    const logOutput = consoleLogSpy.mock.calls.map(args => args.join(' ')).join(' ');
    expect(logOutput).toContain('***5700');
    expect(logOutput).not.toContain('470-428-5700');
    expect(logOutput).not.toContain('14704285700');
    expect(logOutput).not.toContain('Sophia Dowd');
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
    expect(result.requiredExtraMinutes).toBe(15);
    expect(result.availableGapMinutes).toBe(40);
    expect(result.pricing.memberDelta).toBe(40);
  });

  it('uses tier duration when appointment includes only transition buffer above tier length', () => {
    const appointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:45:00.000Z', // 30 min service + 15 min transition
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
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
    expect(result.currentDurationMinutes).toBe(30);
    expect(result.targetDurationMinutes).toBe(50);
    expect(result.requiredExtraMinutes).toBe(15);
  });

  it('infers 30-minute service for guests when raw appointment length is 30 + transition', () => {
    const appointments = [
      {
        id: 'appt-guest-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:45:00.000Z', // 30 min service + 15 min transition
        status: 'BOOKED',
      },
      {
        id: 'appt-guest-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-03-08T11:20:00.000Z',
        endOn: '2026-03-08T11:50:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, {
      clientId: 'client-1',
      tier: null,
      accountStatus: 'active',
    }, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(true);
    expect(result.currentDurationMinutes).toBe(30);
    expect(result.targetDurationMinutes).toBe(50);
  });

  it('treats 15 minutes after appointment end as eligible for 30->50', () => {
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

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.availableGapMinutes).toBe(30);
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
    expect(result.availableGapMinutes).toBe(35);
    expect(result.requiredExtraMinutes).toBe(15);
  });

  it('treats less than 15 minutes after appointment end as ineligible for 30->50', () => {
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
        startOn: '2026-03-08T10:44:00.000Z',
        endOn: '2026-03-08T11:14:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.availableGapMinutes).toBe(14);
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

    expect(result.eligible).toBe(false);
    expect(result.currentDurationMinutes).toBe(50);
    expect(result.targetDurationMinutes).toBeNull();
    expect(result.reason).toBe('no_upgrade_target_for_duration');
    expect(result.gapUnlimited).toBe(true);
    expect(result.availableGapMinutes).toBeNull();
    expect(result.pricing).toBeNull();
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
    expect(result.availableGapMinutes).toBe(50);
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
    expect(result.availableGapMinutes).toBe(35);
    expect(result.nextCommitmentStartOn).toBe('2026-03-08T11:05:00.000Z');
  });

  it('fails safe when provider id is unavailable', () => {
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

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('provider_identity_unavailable');
    expect(result.providerIdentityMode).toBe('fallback_no_provider_id');
    expect(result.availableGapMinutes).toBeNull();
  });

  it('fails safe when multiple upcoming appointments exist without explicit appointmentId', () => {
    const appointments = [
      {
        id: 'appt-a',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-b',
        clientId: 'client-1',
        providerId: 'prov-2',
        startOn: '2026-03-08T12:00:00.000Z',
        endOn: '2026-03-08T12:30:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('multiple_upcoming_appointments_require_appointment_id');
  });

  it('uses provided appointmentId when multiple upcoming appointments exist', () => {
    const appointments = [
      {
        id: 'appt-a',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-03-08T10:00:00.000Z',
        endOn: '2026-03-08T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-b',
        clientId: 'client-1',
        providerId: 'prov-2',
        startOn: '2026-03-08T12:00:00.000Z',
        endOn: '2026-03-08T12:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'prov-2-next',
        clientId: 'other',
        providerId: 'prov-2',
        startOn: '2026-03-08T13:05:00.000Z',
        endOn: '2026-03-08T13:35:00.000Z',
        status: 'BOOKED',
      },
    ];

    const result = evaluateUpgradeEligibilityFromAppointments(appointments, profile, {
      now: '2026-03-08T08:00:00.000Z',
      windowHours: 6,
      appointmentId: 'appt-b',
    });

    expect(result.eligible).toBe(true);
    expect(result.appointmentId).toBe('appt-b');
    expect(result.availableGapMinutes).toBe(35);
  });

  it('fails safe when provider identity is unavailable even if other-location bookings exist', () => {
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

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('provider_identity_unavailable');
    expect(result.locationCanonicalId).toBe('urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb');
    expect(result.nextCommitmentStartOn).toBeNull();
    expect(result.gapUnlimited).toBeNull();
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
    expect(result.availableGapMinutes).toBe(40);
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

  it('recovers provider identity from appointment context when scan omits providerId', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'notes',
                      args: [],
                      type: scalarType('String'),
                    },
                  ],
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

      if (body.query.includes('IntrospectType')) {
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
                    { name: 'locationId' },
                    { name: 'status' },
                    { name: 'canceledAt' },
                  ],
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
                      locationId: 'loc-1',
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
                      locationId: 'loc-1',
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

      if (body.query.includes('FetchAppointmentContext')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointment: {
                id: 'appt-1',
                clientId: 'client-1',
                locationId: 'loc-1',
                startAt: '2026-03-08T10:00:00.000Z',
                endAt: '2026-03-08T10:30:00.000Z',
                notes: 'Internal note',
                appointmentServices: [
                  {
                    id: 'aps-1',
                    serviceId: 'svc-30',
                    staffId: 'prov-1',
                  },
                ],
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
    expect(result.appointmentId).toBe('appt-1');
    expect(result.providerId).toBe('prov-1');
    expect(result.providerContextRecovered).toBe(true);
  });

  it('recovers provider context for 50-minute bookings so add-on gap metadata is available', async () => {
    const scalarType = (name = 'String') => ({ kind: 'SCALAR', name, ofType: null });
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const typeName = body?.variables?.typeName;

      if (body.query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'notes',
                      args: [],
                      type: scalarType('String'),
                    },
                  ],
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

      if (body.query.includes('IntrospectType')) {
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
                    { name: 'locationId' },
                    { name: 'status' },
                    { name: 'canceledAt' },
                  ],
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
                      locationId: 'loc-1',
                      startOn: '2026-03-08T10:00:00.000Z',
                      endOn: '2026-03-08T10:50:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                  {
                    node: {
                      id: 'appt-2',
                      clientId: 'other',
                      providerId: 'prov-1',
                      locationId: 'loc-1',
                      startOn: '2026-03-08T11:00:00.000Z',
                      endOn: '2026-03-08T11:30:00.000Z',
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

      if (body.query.includes('FetchAppointmentContext')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointment: {
                id: 'appt-1',
                clientId: 'client-1',
                locationId: 'loc-1',
                startAt: '2026-03-08T10:00:00.000Z',
                endAt: '2026-03-08T10:50:00.000Z',
                notes: 'Internal note',
                appointmentServices: [
                  {
                    id: 'aps-1',
                    serviceId: 'svc-50',
                    staffId: 'prov-1',
                  },
                ],
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
      { clientId: 'client-1', tier: '50', accountStatus: 'active' },
      { now: '2026-03-08T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('no_upgrade_target_for_duration');
    expect(result.currentDurationMinutes).toBe(50);
    expect(result.providerId).toBe('prov-1');
    expect(result.availableGapMinutes).toBe(10);
    expect(result.gapUnlimited).toBe(false);
    expect(result.providerContextRecovered).toBe(true);
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
                      locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
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
                      locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
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
