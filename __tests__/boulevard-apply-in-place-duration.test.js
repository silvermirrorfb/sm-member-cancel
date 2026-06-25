import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix A: the duration upgrade is an IN-PLACE edit of the existing editing-linked
// booking-service line (bookingServiceSetDurations -> target, bookingServiceSetPrice
// -> quoted), then bookingComplete. No bookingAddService / bookingRemoveService, so
// no second (unlinked) service line is ever created and STAFF_DOUBLE_BOOKED cannot
// fire from a self-overlap. cancelAppointment is never called.

vi.mock('../src/lib/sms-metrics.js', () => ({
  incrementUpgradeApplyFailureCount: vi.fn(),
  getUpgradeApplyFailureCount: vi.fn(),
}));

const originalEnv = process.env;
const originalFetch = global.fetch;
const json = (payload) => ({ ok: true, json: async () => payload });

// Records every GraphQL operation so tests can assert which mutations ran.
let calls;
function buildFetch({ durationWarnings = [], completeWarnings = [], reject = null } = {}) {
  let completed = false;
  const rejects = Array.isArray(reject) ? reject : reject ? [reject] : [];
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || '');
    const typeName = String(body?.variables?.typeName || '');
    for (const root of ['bookingCreateFromAppointment', 'bookingServiceSetDurations', 'bookingServiceSetPrice', 'bookingAddService', 'bookingRemoveService', 'bookingComplete', 'cancelAppointment', 'appointmentCancel']) {
      if (query.includes(root)) calls.push(root);
    }
    if (query.includes('IntrospectType(')) {
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
      if (typeName === 'Appointment') return json({ data: { __type: { fields: ['id','startOn','endOn','clientId','providerId','locationId','status','canceledAt'].map(name => ({ name })) } } });
    }
    if (query.includes('IntrospectTypeDetailed')) {
      if (typeName === 'Appointment') return json({ data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } } });
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments', args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } }, { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } }], type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null } }] } } });
    }
    if (query.includes('FetchAppointmentContext')) {
      return json({ data: { appointment: {
        id: 'appt-1', clientId: 'client-1',
        locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
        startAt: '2026-06-04T14:00:00.000Z', endAt: '2026-06-04T14:30:00.000Z', notes: 'note',
        appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
      } } });
    }
    if (query.includes('ScanAppointments')) {
      return json({ data: { appointments: { edges: [
        { node: { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null } },
        { node: { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T16:00:00.000Z', endOn: '2026-06-04T16:30:00.000Z', status: 'BOOKED', canceledAt: null } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes('VerifyApptDuration')) {
      const d = completed ? 50 : 30;
      return json({ data: { appointment: { id: 'appt-1', duration: d, appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', duration: d, totalDuration: d }] } } });
    }
    if (rejects.some(r => query.includes(r))) return json({ errors: [{ message: 'rejected ' + rejects.join(',') }], data: null });
    if (query.includes('bookingCreateFromAppointment')) {
      return json({ data: { bookingCreateFromAppointment: { booking: {
        id: 'bk-1', bookingClients: [{ id: 'bc-1', clientId: 'client-1' }],
        bookingServices: [{ id: 'bs-base', baseBookingServiceId: null, editingAppointmentServiceId: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
      }, bookingWarnings: [] } } });
    }
    if (query.includes('bookingServiceSetDurations')) return json({ data: { bookingServiceSetDurations: { booking: { id: 'bk-1' }, bookingWarnings: durationWarnings } } });
    if (query.includes('bookingServiceSetPrice')) return json({ data: { bookingServiceSetPrice: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    if (query.includes('bookingAddService')) return json({ data: { bookingAddService: { booking: { id: 'bk-1' }, bookingService: { id: 'bs-50', serviceId: 'svc-50', staffId: 'prov-1' }, bookingWarnings: [] } } });
    if (query.includes('bookingRemoveService')) return json({ data: { bookingRemoveService: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
    if (query.includes('bookingComplete')) { completed = true; return json({ data: { bookingComplete: { booking: { id: 'bk-1' }, bookingAppointments: [{ appointmentId: 'appt-1', clientId: 'client-1' }], bookingWarnings: completeWarnings } } }); }
    return json({ data: {} });
  });
}

function env(extra = {}) {
  return { ...originalEnv, NODE_ENV: 'test', BOULEVARD_API_KEY: 'key', BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'), BOULEVARD_BUSINESS_ID: 'biz', BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin', BOULEVARD_SERVICE_ID_50MIN: 'svc-50', BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true', BOULEVARD_ENABLE_BOOKING_UPGRADE: 'true', ...extra };
}
async function runReverify() {
  vi.resetModules();
  const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
  __resetBoulevardCachesForTests();
  return reverifyAndApplyUpgradeForProfile({ clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' }, { appointmentId: 'appt-1', targetDurationMinutes: 50, totalDollars: 169 }, { now: '2026-06-04T12:00:00.000Z', windowHours: 6 });
}

describe('Fix A: in-place duration upgrade (no service swap, no self-overlap)', () => {
  beforeEach(() => { calls = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('edits the existing line in place (setDurations + setPrice) and never adds/removes a service line or cancels', async () => {
    process.env = env(); global.fetch = buildFetch();
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingServiceSetDurations');
    expect(calls).toContain('bookingServiceSetPrice');
    expect(calls).toContain('bookingComplete');
    expect(calls).not.toContain('bookingAddService');
    expect(calls).not.toContain('bookingRemoveService');
    expect(calls).not.toContain('cancelAppointment');
    expect(calls).not.toContain('appointmentCancel');
    expect(result.updatedAppointmentId).toBe('appt-1');
  });

  it('a genuine STAFF_DOUBLE_BOOKED warning still blocks (aborts before bookingComplete)', async () => {
    process.env = env();
    global.fetch = buildFetch({ durationWarnings: [{ code: 'STAFF_DOUBLE_BOOKED', message: 'Appointment is double booked', staffId: 'prov-1', serviceId: 'svc-30' }] });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(String(result.reason)).toContain('warning_block');
    expect(calls).not.toContain('bookingComplete');
  });

  it('a mutation failure aborts before commit (no bookingComplete)', async () => {
    process.env = env();
    global.fetch = buildFetch({ reject: 'bookingServiceSetDurations' });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });
});
