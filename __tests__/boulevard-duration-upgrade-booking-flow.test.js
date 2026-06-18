import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Booking-flow duration upgrade (outbound-sms #13). The legacy
// updateAppointment(serviceId) mutation is invalid in Boulevard's schema and
// silently fails; this exercises the non-destructive booking-edit swap that
// replaces it: bookingCreateFromAppointment -> bookingAddService (50-min) ->
// bookingRemoveService (30-min) -> bookingServiceSetPrice -> bookingComplete,
// gated behind BOULEVARD_ENABLE_BOOKING_UPGRADE.

const originalEnv = process.env;
const originalFetch = global.fetch;

function json(payload) {
  return { ok: true, json: async () => payload };
}

// Records booking-mutation order and lets each test script warnings.
function buildBookingFetch(opts = {}) {
  const order = [];
  let completed = false;
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || '');
    const typeName = String(body?.variables?.typeName || '');

    if (query.includes('IntrospectType(')) {
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
      if (typeName === 'Appointment') {
        return json({ data: { __type: { fields: [
          { name: 'id' }, { name: 'startOn' }, { name: 'endOn' }, { name: 'clientId' },
          { name: 'providerId' }, { name: 'locationId' }, { name: 'status' }, { name: 'canceledAt' },
        ] } } });
      }
    }
    if (query.includes('IntrospectTypeDetailed')) {
      if (typeName === 'Appointment') {
        return json({ data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } } });
      }
      if (typeName === 'Query') {
        return json({ data: { __type: { fields: [{
          name: 'appointments',
          args: [
            { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
            { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } },
          ],
          type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
        }] } } });
      }
    }

    if (query.includes('FetchAppointmentContext')) {
      const currentServiceId = completed ? 'svc-50' : 'svc-30';
      return json({ data: { appointment: {
        id: 'appt-1', clientId: 'client-1',
        locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
        startAt: '2026-06-04T14:00:00.000Z', endAt: '2026-06-04T14:30:00.000Z',
        notes: 'note',
        appointmentServices: [{ id: 'aps-1', serviceId: currentServiceId, staffId: 'prov-1' }],
      } } });
    }

    if (query.includes('ScanAppointments')) {
      return json({ data: { appointments: { edges: [
        { node: { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null } },
        { node: { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T16:00:00.000Z', endOn: '2026-06-04T16:30:00.000Z', status: 'BOOKED', canceledAt: null } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }

    if (query.includes('bookingCreateFromAppointment')) {
      order.push('create');
      return json({ data: { bookingCreateFromAppointment: {
        booking: {
          id: 'bk-1',
          bookingClients: [{ id: 'bc-1', clientId: 'client-1' }],
          bookingServices: [{ id: 'bs-30', baseBookingServiceId: null, editingAppointmentServiceId: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
        },
        bookingWarnings: [],
      } } });
    }
    if (query.includes('bookingAddService')) {
      order.push('add');
      return json({ data: { bookingAddService: {
        booking: { id: 'bk-1' },
        bookingService: { id: 'bs-50', serviceId: 'svc-50', staffId: 'prov-1' },
        bookingWarnings: opts.addWarnings || [],
      } } });
    }
    if (query.includes('bookingRemoveService')) {
      order.push('remove');
      return json({ data: { bookingRemoveService: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingServiceSetPrice')) {
      order.push('price:' + body?.variables?.input?.price);
      return json({ data: { bookingServiceSetPrice: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingComplete')) {
      order.push('complete');
      completed = true;
      return json({ data: { bookingComplete: {
        booking: { id: 'bk-1' },
        bookingAppointments: [{ appointmentId: 'appt-1', clientId: 'client-1' }],
        bookingWarnings: [],
      } } });
    }

    return json({ data: {} });
  });
  fetchMock.order = order;
  return fetchMock;
}

async function runReverify(pendingExtra = {}) {
  vi.resetModules();
  const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
  __resetBoulevardCachesForTests();
  return reverifyAndApplyUpgradeForProfile(
    { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
    { appointmentId: 'appt-1', targetDurationMinutes: 50, ...pendingExtra },
    { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
  );
}

describe('duration upgrade booking-edit apply flow', () => {
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
      BOULEVARD_ENABLE_BOOKING_UPGRADE: 'true',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('swaps the service in place (add 50 before removing 30) then completes and verifies', async () => {
    const fetchMock = buildBookingFetch();
    global.fetch = fetchMock;

    const result = await runReverify({ totalDollars: 139 });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(result.updatedAppointmentId).toBe('appt-1');

    const steps = fetchMock.order.filter(s => ['create', 'add', 'remove', 'complete'].includes(s));
    expect(steps).toEqual(['create', 'add', 'remove', 'complete']);
    // Add strictly before remove so the booking is never left empty.
    expect(steps.indexOf('add')).toBeLessThan(steps.indexOf('remove'));
  });

  it('honors the quoted price by setting the booking service price in cents', async () => {
    const fetchMock = buildBookingFetch();
    global.fetch = fetchMock;

    await runReverify({ totalDollars: 139 });

    expect(fetchMock.order).toContain('price:13900');
    // price-set happens before the commit.
    expect(fetchMock.order.indexOf('price:13900')).toBeLessThan(fetchMock.order.indexOf('complete'));
  });

  it('aborts before bookingComplete and before removing the original on a blocking add warning', async () => {
    const fetchMock = buildBookingFetch({ addWarnings: [{ code: 'STAFF_DOUBLE_BOOKED', message: 'conflict' }] });
    global.fetch = fetchMock;

    const result = await runReverify({ totalDollars: 139 });

    expect(result.success).toBe(false);
    expect(fetchMock.order).not.toContain('remove'); // original 30-min never removed
    expect(fetchMock.order).not.toContain('complete'); // live appointment never committed
  });

  it('never issues a destructive cancel or a fresh booking create', async () => {
    const fetchMock = buildBookingFetch();
    global.fetch = fetchMock;

    await runReverify({ totalDollars: 139 });

    const allQueries = fetchMock.mock.calls.map(c => JSON.parse(c[1].body).query).join('\n');
    expect(allQueries).not.toContain('cancelAppointment');
    expect(allQueries).toContain('bookingCreateFromAppointment'); // edits in place, no cancel-rebook
  });
});
