import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = process.env;
const originalFetch = global.fetch;

function json(payload) {
  return { ok: true, json: async () => payload };
}

// Builds a fetch mock for the duration reverify path. `postMutationServiceId`
// is the serviceId FetchAppointmentContext reports AFTER the mutation runs
// (the read-back). Before the mutation it always reports 'svc-30'.
function buildFetch(postMutationServiceId) {
  let mutationApplied = false;
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || '');
    const typeName = String(body?.variables?.typeName || '');

    if (query.includes('IntrospectType(')) {
      if (typeName === 'Query') {
        return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
      }
      if (typeName === 'Appointment') {
        return json({
          data: {
            __type: {
              fields: [
                { name: 'id' },
                { name: 'startOn' },
                { name: 'endOn' },
                { name: 'clientId' },
                { name: 'providerId' },
                { name: 'locationId' },
                { name: 'status' },
                { name: 'canceledAt' },
              ],
            },
          },
        });
      }
    }

    if (query.includes('IntrospectTypeDetailed')) {
      if (typeName === 'Appointment') {
        return json({
          data: {
            __type: {
              fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }],
            },
          },
        });
      }
      if (typeName === 'Query') {
        return json({
          data: {
            __type: {
              fields: [
                {
                  name: 'appointments',
                  args: [
                    { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                    { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                  ],
                  type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
                },
              ],
            },
          },
        });
      }
    }

    if (query.includes('FetchAppointmentContext')) {
      const currentServiceId = mutationApplied ? postMutationServiceId : 'svc-30';
      return json({
        data: {
          appointment: {
            id: 'appt-1',
            clientId: 'client-1',
            locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
            startAt: '2026-06-04T14:00:00.000Z',
            endAt: '2026-06-04T14:30:00.000Z',
            notes: 'Original internal note',
            appointmentServices: [{ id: 'aps-1', serviceId: currentServiceId, staffId: 'prov-1' }],
          },
        },
      });
    }

    if (query.includes('ScanAppointments')) {
      return json({
        data: {
          appointments: {
            edges: [
              {
                node: {
                  id: 'appt-1',
                  clientId: 'client-1',
                  providerId: 'prov-1',
                  locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                  startOn: '2026-06-04T14:00:00.000Z',
                  endOn: '2026-06-04T14:30:00.000Z',
                  status: 'BOOKED',
                  canceledAt: null,
                },
              },
              {
                node: {
                  id: 'appt-next',
                  clientId: 'other',
                  providerId: 'prov-1',
                  locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                  startOn: '2026-06-04T15:10:00.000Z',
                  endOn: '2026-06-04T15:40:00.000Z',
                  status: 'BOOKED',
                  canceledAt: null,
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (query.includes('mutation UpgradeAppointment') || query.includes('mutation UpgradeAppointmentAlt')) {
      mutationApplied = true;
      return json({ data: { updateAppointment: { appointment: { id: 'appt-1' } } } });
    }

    return json({ data: {} });
  });
  return fetchMock;
}

describe('duration upgrade read-back verification', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns non-success when the mutation reports an id but the service did not change', async () => {
    global.fetch = buildFetch('svc-30'); // read-back still shows the old 30-min service
    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('upgrade_verification_failed');
  });

  it('returns success only after the read-back confirms the target service is applied', async () => {
    global.fetch = buildFetch('svc-50'); // read-back shows the upgraded 50-min service
    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(result.updatedAppointmentId).toBe('appt-1');
  });

  it('fails closed when the read-back fetch errors after the mutation', async () => {
    // The mutation succeeds, but the post-mutation read-back returns a GraphQL
    // error. fetchAppointmentContextById turns that into null, so the verifier
    // must return false and the upgrade must NOT be reported as applied.
    let mutationApplied = false;
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      const typeName = String(body?.variables?.typeName || '');

      if (query.includes('IntrospectType(')) {
        if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
        if (typeName === 'Appointment') {
          return json({
            data: {
              __type: {
                fields: [
                  { name: 'id' }, { name: 'startOn' }, { name: 'endOn' }, { name: 'clientId' },
                  { name: 'providerId' }, { name: 'locationId' }, { name: 'status' }, { name: 'canceledAt' },
                ],
              },
            },
          });
        }
      }
      if (query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return json({ data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } } });
        }
        if (typeName === 'Query') {
          return json({
            data: {
              __type: {
                fields: [{
                  name: 'appointments',
                  args: [
                    { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                    { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                  ],
                  type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
                }],
              },
            },
          });
        }
      }
      if (query.includes('FetchAppointmentContext')) {
        // After the mutation, the read-back fetch errors out.
        if (mutationApplied) return json({ errors: [{ message: 'Boulevard read-back timeout' }] });
        return json({
          data: {
            appointment: {
              id: 'appt-1',
              clientId: 'client-1',
              locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
              startAt: '2026-06-04T14:00:00.000Z',
              endAt: '2026-06-04T14:30:00.000Z',
              notes: 'Original internal note',
              appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
            },
          },
        });
      }
      if (query.includes('ScanAppointments')) {
        return json({
          data: {
            appointments: {
              edges: [
                { node: { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null } },
                { node: { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T15:10:00.000Z', endOn: '2026-06-04T15:40:00.000Z', status: 'BOOKED', canceledAt: null } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (query.includes('mutation UpgradeAppointment') || query.includes('mutation UpgradeAppointmentAlt')) {
        mutationApplied = true;
        return json({ data: { updateAppointment: { appointment: { id: 'appt-1' } } } });
      }
      return json({ data: {} });
    });

    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('upgrade_verification_failed');
  });
});
