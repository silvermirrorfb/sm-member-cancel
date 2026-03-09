import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
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
});
