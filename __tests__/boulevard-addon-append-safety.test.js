import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const originalEnv = process.env;
const originalFetch = global.fetch;

function json(payload) {
  return {
    ok: true,
    json: async () => payload,
  };
}

function scalarField(name) {
  return {
    name,
    args: [],
    type: { kind: 'SCALAR', name: 'String', ofType: null },
  };
}

function appointmentContextPayload() {
  return {
    data: {
      appointment: {
        id: 'appt-addon-1',
        clientId: 'client-addon-1',
        locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
        startAt: '2026-06-03T14:00:00.000Z',
        endAt: '2026-06-03T14:50:00.000Z',
        notes: 'Keep this appointment intact.',
        appointmentServices: [
          {
            id: 'appointment-service-base-1',
            serviceId: 'svc-50',
            staffId: 'staff-1',
          },
        ],
      },
    },
  };
}

function scanPayload() {
  return {
    data: {
      appointments: {
        edges: [
          {
            node: {
              id: 'appt-addon-1',
              clientId: 'client-addon-1',
              providerId: 'staff-1',
              locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
              startOn: '2026-06-03T14:00:00.000Z',
              endOn: '2026-06-03T14:50:00.000Z',
              status: 'BOOKED',
              canceledAt: null,
            },
          },
          {
            node: {
              id: 'appt-next',
              clientId: 'other-client',
              providerId: 'staff-1',
              locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
              startOn: '2026-06-03T15:10:00.000Z',
              endOn: '2026-06-03T15:40:00.000Z',
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
  };
}

describe('add-on append safety', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK: 'true',
      BOULEVARD_ADDON_SERVICE_ID_ANTIOXIDANT_PEEL: 'svc-addon',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not keep destructive add-on cancel-rebook code in boulevard.js', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, '../src/lib/boulevard.js'), 'utf8');

    expect(source).not.toContain('tryApplyAddonViaCancelRebook');
    expect(source).not.toContain('CancelAppointmentForAddon');
    expect(source).not.toContain('applied_addon_cancel_rebook');
  });

  it('never calls cancelAppointment when non-destructive add-on append fails', async () => {
    let cancelCalled = false;

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      const typeName = String(body?.variables?.typeName || '');
      const id = String(body?.variables?.id || '');

      if (query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return json({ data: { __type: { fields: [scalarField('notes')] } } });
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

      if (query.includes('FetchAppointmentContext')) return json(appointmentContextPayload());

      if (query.includes('FetchServiceContext')) {
        if (id === 'svc-addon') {
          return json({
            data: {
              service: {
                id: 'svc-addon',
                name: 'Antioxidant Peel',
                addon: true,
                active: true,
                defaultDuration: 10,
                defaultPrice: 5000,
              },
            },
          });
        }
        return json({
          data: {
            service: {
              id,
              name: '50 Minute Facial',
              addon: false,
              active: true,
              defaultDuration: 50,
              defaultPrice: 16900,
            },
          },
        });
      }

      if (query.includes('ScanAppointments')) return json(scanPayload());

      if (query.includes('BookingCreateFromAppointmentForAddon')) {
        return json({ errors: [{ message: 'Boulevard failed to open appointment edit booking.' }] });
      }

      if (query.includes('CancelAppointmentForAddon') || query.includes('cancelAppointment')) {
        cancelCalled = true;
        return json({
          data: {
            cancelAppointment: {
              appointment: { id: 'appt-addon-1', cancelled: true, state: 'CANCELED' },
            },
          },
        });
      }

      return json({ data: {} });
    });

    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-addon-1', tier: '50', accountStatus: 'ACTIVE' },
      {
        offerKind: 'addon',
        appointmentId: 'appt-addon-1',
        currentDurationMinutes: 50,
        addOnCode: 'antioxidant_peel',
        addOnName: 'Antioxidant Peel',
        pricing: { memberPrice: 40, walkinPrice: 50 },
      },
      { now: '2026-06-03T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('addon_booking_from_appointment_failed');
    expect(cancelCalled).toBe(false);
    expect(global.fetch.mock.calls.some(([, init]) => String(JSON.parse(init.body).query || '').includes('CancelAppointmentForAddon'))).toBe(false);
  });
});
