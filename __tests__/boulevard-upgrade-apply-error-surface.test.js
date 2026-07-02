import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-1 (hardening 2026-06-19): de-silence the upgrade apply path. A Boulevard
// rejection in the apply mutation (both the #63 booking-edit path and the legacy
// tryApplyAppointmentUpgradeMutation path) must surface loudly: an error-level
// log carrying the Boulevard error text, a daily failure counter, and the error
// text propagated up so the support incident can record it. This file proves the
// log + capture + count + failure-never-success behavior. No mutation logic is
// changed and the dormant BOULEVARD_ENABLE_BOOKING_UPGRADE flag is not enabled
// here beyond exercising the booking branch.

const mockIncrementUpgradeApplyFailureCount = vi.fn();
const mockGetUpgradeApplyFailureCount = vi.fn();
vi.mock('../src/lib/sms-metrics.js', () => ({
  incrementUpgradeApplyFailureCount: (...a) => mockIncrementUpgradeApplyFailureCount(...a),
  getUpgradeApplyFailureCount: (...a) => mockGetUpgradeApplyFailureCount(...a),
}));

const originalEnv = process.env;
const originalFetch = global.fetch;

function json(payload) {
  return { ok: true, json: async () => payload };
}

// Mirrors the booking-flow test mock, but lets a chosen mutation return a
// Boulevard GraphQL error so the apply path is rejected. `reject` is matched
// against the query text (e.g. 'bookingCreateFromAppointment', 'updateAppointment').
function buildFetch({ reject = null, rejectMessage = 'Service is not bookable' } = {}) {
  let completed = false;
  const rejects = Array.isArray(reject) ? reject : reject ? [reject] : [];
  const shouldReject = (query) => rejects.some(r => query.includes(r));
  return vi.fn(async (_url, init) => {
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

    if (query.includes('VerifyApptDuration')) {
      const d = completed ? 50 : 30;
      return json({ data: { appointment: { id: 'appt-1', duration: d, appointmentServices: [{ id: 'aps-1', serviceId: completed ? 'svc-50' : 'svc-30', duration: d, totalDuration: d }] } } });
    }

    if (query.includes('ScanTimeblocks')) {
      // P1-A: the in-place duration apply now also scans staff timeblocks; no blocks here -> window clear.
      return json({ data: { timeblocks: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes('ScanAppointments')) {
      return json({ data: { appointments: { edges: [
        { node: { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null } },
        { node: { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T16:00:00.000Z', endOn: '2026-06-04T16:30:00.000Z', status: 'BOOKED', canceledAt: null } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }

    // Apply mutations. Reject the chosen one with a Boulevard GraphQL error.
    const isMutation = query.includes('bookingCreateFromAppointment')
      || query.includes('bookingServiceSetDurations')
      || query.includes('bookingAddService')
      || query.includes('bookingRemoveService')
      || query.includes('bookingServiceSetPrice')
      || query.includes('bookingComplete')
      || query.includes('updateAppointment')
      || query.includes('appointmentUpdate');

    if (isMutation && shouldReject(query)) {
      return json({ errors: [{ message: rejectMessage }], data: null });
    }

    if (query.includes('bookingCreateFromAppointment')) {
      return json({ data: { bookingCreateFromAppointment: {
        booking: {
          id: 'bk-1',
          bookingClients: [{ id: 'bc-1', clientId: 'client-1' }],
          bookingServices: [{ id: 'bs-30', baseBookingServiceId: null, editingAppointmentServiceId: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
        },
        bookingWarnings: [],
      } } });
    }
    if (query.includes('bookingServiceSetDurations')) {
      return json({ data: { bookingServiceSetDurations: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingAddService')) {
      return json({ data: { bookingAddService: { booking: { id: 'bk-1' }, bookingService: { id: 'bs-50', serviceId: 'svc-50', staffId: 'prov-1' }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingRemoveService')) {
      return json({ data: { bookingRemoveService: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingServiceSetPrice')) {
      return json({ data: { bookingServiceSetPrice: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingComplete')) {
      completed = true;
      return json({ data: { bookingComplete: { booking: { id: 'bk-1' }, bookingAppointments: [{ appointmentId: 'appt-1', clientId: 'client-1' }], bookingWarnings: [] } } });
    }
    // Legacy mutation success shape (unused in rejection tests).
    if (query.includes('updateAppointment')) {
      return json({ data: { updateAppointment: { appointment: { id: 'appt-1' } } } });
    }
    if (query.includes('appointmentUpdate')) {
      return json({ data: { appointmentUpdate: { appointment: { id: 'appt-1' } } } });
    }

    return json({ data: {} });
  });
}

function baseEnv(extra = {}) {
  return {
    ...originalEnv,
    NODE_ENV: 'test',
    BOULEVARD_API_KEY: 'key',
    BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
    BOULEVARD_BUSINESS_ID: 'biz-id',
    BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
    BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
    ...extra,
  };
}

async function runReverify() {
  vi.resetModules();
  const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
  __resetBoulevardCachesForTests();
  return reverifyAndApplyUpgradeForProfile(
    { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
    { appointmentId: 'appt-1', targetDurationMinutes: 50 },
    { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
  );
}

describe('upgrade apply error surfacing (PR-1 de-silence)', () => {
  let errorSpy;
  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('summarizeBoulevardApplyError', () => {
    it('renders graphql, http, empty, and missing shapes into a compact string with the Boulevard text', async () => {
      vi.resetModules();
      const { summarizeBoulevardApplyError } = await import('../src/lib/boulevard.js');
      expect(summarizeBoulevardApplyError({ stage: 'graphql', errors: [{ message: 'Service is not bookable' }] }))
        .toContain('Service is not bookable');
      const httpStr = summarizeBoulevardApplyError({ stage: 'http', status: 400, bodyPreview: 'bad request' });
      expect(httpStr).toContain('400');
      expect(httpStr).toContain('bad request');
      expect(summarizeBoulevardApplyError({ stage: 'empty_payload' })).toContain('empty_payload');
      expect(typeof summarizeBoulevardApplyError(null)).toBe('string');
      expect(summarizeBoulevardApplyError(null).length).toBeGreaterThan(0);
    });
  });

  describe('#63 booking-edit apply path', () => {
    it('logs the Boulevard error, captures the message, counts the failure, and reports failure never success', async () => {
      process.env = baseEnv({ BOULEVARD_ENABLE_BOOKING_UPGRADE: 'true' });
      global.fetch = buildFetch({ reject: 'bookingCreateFromAppointment', rejectMessage: 'Service is not bookable' });

      const result = await runReverify();

      expect(result.success).toBe(false);
      expect(result.reason).not.toBe('applied');
      // Boulevard error text captured on the result so the incident can record it.
      expect(JSON.stringify(result.error)).toContain('Service is not bookable');
      // Error-level log carries the Boulevard text.
      const logged = errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('Service is not bookable');
      // Counted exactly once for the rejected apply attempt.
      expect(mockIncrementUpgradeApplyFailureCount).toHaveBeenCalledTimes(1);
    });
  });

  describe('legacy tryApplyAppointmentUpgradeMutation path', () => {
    it('logs the Boulevard error, captures the message, counts the failure, and reports failure never success', async () => {
      // Flag OFF, so reverify falls through to the legacy direct mutation path.
      process.env = baseEnv({ BOULEVARD_ENABLE_BOOKING_UPGRADE: 'false' });
      global.fetch = buildFetch({ reject: ['updateAppointment', 'appointmentUpdate'], rejectMessage: 'updateAppointment is not a valid field' });

      const result = await runReverify();

      expect(result.success).toBe(false);
      expect(result.reason).toBe('upgrade_mutation_failed');
      expect(JSON.stringify(result.error)).toContain('updateAppointment is not a valid field');
      const logged = errorSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('updateAppointment is not a valid field');
      expect(mockIncrementUpgradeApplyFailureCount).toHaveBeenCalledTimes(1);
    });
  });

  describe('successful apply', () => {
    it('does not count a failure and surfaces no error', async () => {
      process.env = baseEnv({ BOULEVARD_ENABLE_BOOKING_UPGRADE: 'true' });
      global.fetch = buildFetch();

      const result = await runReverify();

      expect(result.success).toBe(true);
      expect(result.reason).toBe('applied');
      expect(result.error == null).toBe(true);
      expect(mockIncrementUpgradeApplyFailureCount).not.toHaveBeenCalled();
    });
  });
});
