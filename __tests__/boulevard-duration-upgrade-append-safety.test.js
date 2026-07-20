import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const originalEnv = process.env;
const originalFetch = global.fetch;

describe('duration-upgrade append safety', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Non-production on purpose. With the fallback flag on, the only reason a
      // cancel must not fire is that the cancel-rebook code was deleted.
      NODE_ENV: 'test',
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK: 'true',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not keep destructive duration cancel-rebook code in boulevard.js', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, '../src/lib/boulevard.js'), 'utf8');

    expect(source).not.toContain('tryApplyUpgradeViaCancelRebook');
    expect(source).not.toContain('CancelAppointmentForUpgrade');
    expect(source).not.toContain('applied_cancel_rebook');
  });

  it('never calls cancelAppointment when the in-place duration upgrade fails, even with the fallback flag on outside production', async () => {
    let cancelCalled = false;

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      const typeName = String(body?.variables?.typeName || '');

      if (query.includes('IntrospectType(')) {
        if (typeName === 'Query') {
          return { ok: true, json: async () => ({ data: { __type: { fields: [{ name: 'appointments' }] } } }) };
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
                    { name: 'locationId' },
                    { name: 'status' },
                    { name: 'canceledAt' },
                  ],
                },
              },
            }),
          };
        }
      }

      if (query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } },
            }),
          };
        }
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({
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
            }),
          };
        }
      }

      if (query.includes('FetchAppointmentContext')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointment: {
                id: 'appt-1',
                clientId: 'client-1',
                locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                startAt: '2026-03-11T10:00:00.000Z',
                endAt: '2026-03-11T10:30:00.000Z',
                notes: 'Original internal note',
                appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
              },
            },
          }),
        };
      }

      if (query.includes('FetchLocationHours')) {
        // Roomy hours so the shift-end bound (consulted on every eligibility
        // path since the bypass fix) resolves; the commitment gap governs.
        return { ok: true, json: async () => ({ data: { location: { tz: 'UTC', hours: Array.from({ length: 7 }, () => ({ open: true, start: { hour: 0, minute: 0 }, finish: { hour: 23, minute: 0 } })) } } }) };
      }
      if (query.includes('FetchStaffShifts')) {
        return { ok: true, json: async () => ({ data: { shifts: { shifts: [{ staffId: 'prov-1', clockOut: '23:00:00', available: true }] } } }) };
      }
      if (query.includes('ScanAppointments')) {
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
                      startOn: '2026-03-11T10:00:00.000Z',
                      endOn: '2026-03-11T10:30:00.000Z',
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
                      startOn: '2026-03-11T11:05:00.000Z',
                      endOn: '2026-03-11T11:35:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }

      if (query.includes('mutation UpgradeAppointment') || query.includes('mutation UpgradeAppointmentAlt')) {
        return { ok: true, json: async () => ({ errors: [{ message: 'serviceId not supported in updateAppointment input' }] }) };
      }

      if (query.includes('CancelAppointmentForUpgrade') || query.includes('cancelAppointment')) {
        cancelCalled = true;
      }

      return { ok: true, json: async () => ({ data: {} }) };
    });

    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { offerKind: 'duration', appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-03-11T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('upgrade_mutation_failed');
    expect(cancelCalled).toBe(false);
    expect(
      global.fetch.mock.calls.some(([, init]) => String(JSON.parse(init.body).query || '').includes('CancelAppointmentForUpgrade')),
    ).toBe(false);
  });
});
