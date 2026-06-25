import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix A: the duration upgrade is an IN-PLACE edit of the existing editing-linked
// booking-service line (bookingServiceSetDurations -> target, bookingServiceSetPrice
// -> quoted), then bookingComplete. No bookingAddService / bookingRemoveService, so
// no second (unlinked) service line is ever created. cancelAppointment is never called.
//
// The in-place edit ALWAYS provokes a STAFF_DOUBLE_BOOKED warning at setDurations:
// the edit-draft transiently coexists with the source appointment on the same
// staff/time until bookingComplete reconciles it. That self-overlap is benign and
// proven safe (write-test on af985d32: bookingComplete commits in place, same id).
// This suite proves the discriminating policy: PROCEED past the self-overlap warning
// when the staff window is clear of OTHER real appointments; BLOCK a genuine
// collision (a different appointment on the same staff/time), which is the whole
// safety of the change.

vi.mock('../src/lib/sms-metrics.js', () => ({
  incrementUpgradeApplyFailureCount: vi.fn(),
  getUpgradeApplyFailureCount: vi.fn(),
}));

const originalEnv = process.env;
const originalFetch = global.fetch;
const json = (payload) => ({ ok: true, json: async () => payload });

const LOC = 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa';

// Source appointment appt-1: 14:00-14:30 (30 min) with staff prov-1, service svc-30.
// Target upgrade: 50 min => extended occupied window [14:00, 14:50].
const SOURCE_NODE = { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null };
// A later same-staff appointment that does NOT overlap the extended window.
const LATER_NODE = { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T16:00:00.000Z', endOn: '2026-06-04T16:30:00.000Z', status: 'BOOKED', canceledAt: null };

// Records every GraphQL operation and the client-scope of each appointment scan so
// tests can assert which mutations ran and that the collision check is a
// location-scoped scan (no clientId), i.e. it reuses scanAppointments.
let calls;
let scanClientIds;
function buildFetch({
  durationWarnings = [{ code: 'STAFF_DOUBLE_BOOKED', message: 'Appointment is double booked', staffId: 'prov-1', serviceId: 'svc-30', bookingServiceId: 'bs-base' }],
  completeWarnings = [],
  createWarnings = [],
  reject = null,
  locationExtraNodes = [],
  collisionScanFails = false,
} = {}) {
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
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments', args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } }, { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } }, { name: 'clientId', type: { kind: 'SCALAR', name: 'ID', ofType: null } }, { name: 'locationId', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } } }], type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null } }] } } });
    }
    if (query.includes('FetchAppointmentContext')) {
      return json({ data: { appointment: {
        id: 'appt-1', clientId: 'client-1', locationId: LOC,
        startAt: '2026-06-04T14:00:00.000Z', endAt: '2026-06-04T14:30:00.000Z', notes: 'note',
        appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
      } } });
    }
    if (query.includes('ScanAppointments')) {
      const clientScoped = Boolean(body?.variables?.clientId);
      scanClientIds.push(body?.variables?.clientId || null);
      // Client-scoped scan (eligibility) only ever sees the member's own appointments.
      // Location-scoped scan (the collision check) sees the whole location window.
      if (!clientScoped && collisionScanFails) return json({ errors: [{ message: 'scan failed' }], data: null });
      const nodes = clientScoped ? [SOURCE_NODE, LATER_NODE] : [SOURCE_NODE, LATER_NODE, ...locationExtraNodes];
      return json({ data: { appointments: { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
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
      }, bookingWarnings: createWarnings } } });
    }
    if (query.includes('bookingServiceSetDurations')) return json({ data: { bookingServiceSetDurations: { booking: { id: 'bk-1' }, bookingWarnings: durationWarnings } } });
    if (query.includes('bookingServiceSetPrice')) return json({ data: { bookingServiceSetPrice: { booking: { id: 'bk-1' }, bookingWarnings: [] } } });
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

describe('Fix A: in-place duration upgrade (no service swap, no add/remove, no cancel)', () => {
  beforeEach(() => { calls = []; scanClientIds = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('edits the existing line in place and never adds/removes a service line or cancels', async () => {
    process.env = env(); global.fetch = buildFetch({ durationWarnings: [] });
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

  it('PROCEEDS past a self-overlap STAFF_DOUBLE_BOOKED when the staff window is clear (commits in place, same appt id)', async () => {
    process.env = env();
    // default durationWarnings is the self-overlap warning; default scan window is clear.
    global.fetch = buildFetch();
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingComplete');
    expect(result.updatedAppointmentId).toBe('appt-1');
  });

  it('BLOCKS a genuine collision: a different appointment on the same staff overlapping the window (aborts before bookingComplete)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      // A real second-client booking with prov-1 overlapping [14:00, 14:50].
      locationExtraNodes: [{ id: 'appt-collide', clientId: 'client-2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
    expect(calls).not.toContain('cancelAppointment');
  });

  it('FAILS CLOSED: if the collision scan cannot prove the window is clear, the self-overlap is treated as blocking', async () => {
    process.env = env();
    global.fetch = buildFetch({ collisionScanFails: true });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('RESOURCE_DOUBLE_BOOKED still blocks even when the staff window is clear', async () => {
    process.env = env();
    global.fetch = buildFetch({ durationWarnings: [{ code: 'RESOURCE_DOUBLE_BOOKED', message: 'Resource double booked', staffId: 'prov-1', serviceId: 'svc-30', bookingServiceId: 'bs-base' }] });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('STAFF_DOES_NOT_PERFORM_SERVICE still blocks even when the staff window is clear', async () => {
    process.env = env();
    global.fetch = buildFetch({ durationWarnings: [{ code: 'STAFF_DOES_NOT_PERFORM_SERVICE', message: 'Staff does not perform service', staffId: 'prov-1', serviceId: 'svc-30', bookingServiceId: 'bs-base' }] });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('the collision check is a location-scoped scan (reuses scanAppointments, not a new query)', async () => {
    process.env = env();
    global.fetch = buildFetch();
    await runReverify();
    // eligibility scan is client-scoped; the collision check scan is location-scoped (clientId null).
    expect(scanClientIds).toContain('client-1');
    expect(scanClientIds).toContain(null);
  });

  it('a mutation failure aborts before commit (no bookingComplete)', async () => {
    process.env = env();
    global.fetch = buildFetch({ reject: 'bookingServiceSetDurations' });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });
});

describe('hasBlockingBookingWarnings: discriminating policy + id normalization', () => {
  let hasBlockingBookingWarnings;
  beforeEach(async () => {
    vi.resetModules();
    process.env = env();
    ({ hasBlockingBookingWarnings } = await import('../src/lib/boulevard.js'));
  });
  afterEach(() => { process.env = originalEnv; vi.restoreAllMocks(); });

  const bareWarning = { code: 'STAFF_DOUBLE_BOOKED', message: 'Appointment is double booked', staffId: 'f2ac9ebe-6d30-460e-be42-57d961873f58', serviceId: '09ac1b50-2dc7-47d5-ac30-c1a0f523cbdc', bookingServiceId: '93248729-e078-4c93-aef3-f4e8bac07822' };
  const urnContextClear = { baseBookingServiceId: '93248729-e078-4c93-aef3-f4e8bac07822', sourceServiceId: 'urn:blvd:Service:09ac1b50-2dc7-47d5-ac30-c1a0f523cbdc', providerId: 'urn:blvd:Staff:f2ac9ebe-6d30-460e-be42-57d961873f58', staffWindowClear: true };

  it('treats a bare-uuid self-overlap warning as NON-blocking against a full-urn context when the window is clear', () => {
    expect(hasBlockingBookingWarnings([bareWarning], urnContextClear)).toBe(false);
  });

  it('blocks the same self-overlap warning when the staff window is NOT clear', () => {
    expect(hasBlockingBookingWarnings([bareWarning], { ...urnContextClear, staffWindowClear: false })).toBe(true);
  });

  it('blocks RESOURCE_DOUBLE_BOOKED regardless of self-overlap context', () => {
    expect(hasBlockingBookingWarnings([{ ...bareWarning, code: 'RESOURCE_DOUBLE_BOOKED' }], urnContextClear)).toBe(true);
  });

  it('blocks a STAFF_DOUBLE_BOOKED that does NOT match the edited line (different bookingServiceId/service)', () => {
    const otherLine = { code: 'STAFF_DOUBLE_BOOKED', staffId: 'someone-else', serviceId: 'other-svc', bookingServiceId: 'other-line' };
    expect(hasBlockingBookingWarnings([otherLine], urnContextClear)).toBe(true);
  });

  it('without a self-overlap context (addon path), STAFF_DOUBLE_BOOKED stays blocking (unchanged)', () => {
    expect(hasBlockingBookingWarnings([bareWarning])).toBe(true);
  });
});
