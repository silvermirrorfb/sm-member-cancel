import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Add-on apply self-overlap discrimination (live-proven gap 2026-07-22): the
// booking-edit draft opened by bookingCreateFromAppointment transiently coexists
// with its OWN source appointment on the same staff/time, so Boulevard surfaces a
// STAFF_DOUBLE_BOOKED warning on the add-on flow exactly as it does on the
// duration flow. The duration path discriminates (benign self-overlap in a
// proven-clear staff window PROCEEDS; a genuine collision BLOCKS); the add-on
// path passed no context, so every add-on YES hard-aborted at
// addon_booking_add_service_addon_warning_block (incident sheet: 2026-05-18,
// 2026-05-19, 2026-07-22, all with no real collision on the staff). This suite
// pins the SAME discriminating policy for the add-on path: proceed past the
// benign self-overlap (warning naming the edited base line OR the new add-on
// line) when an independent read proves the window [start, endOn + addon
// duration] holds no OTHER real appointment or timeblock on that staff; block a
// genuine collision; fail closed when the window cannot be proven.

vi.mock('../src/lib/sms-metrics.js', () => ({
  incrementUpgradeApplyFailureCount: vi.fn(),
  getUpgradeApplyFailureCount: vi.fn(),
}));

const originalEnv = process.env;
const originalFetch = global.fetch;
const json = (payload) => ({ ok: true, json: async () => payload });

const LOC = 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa';

// Source appointment appt-1: a NATIVE 50-min line, 14:00-15:00 block (50 + 10
// post-staff), staff prov-1. Add-on: svc-addon, 15 minutes -> proven window must
// reach 15:15.
const SOURCE_NODE = { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null };
// A later same-staff appointment OUTSIDE the extended window (starts 16:00).
const LATER_NODE = { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T16:00:00.000Z', endOn: '2026-06-04T16:30:00.000Z', status: 'BOOKED', canceledAt: null };
// A same-staff appointment INSIDE the extended window tail (15:05-15:35): a real collision.
const COLLIDING_NODE = { id: 'appt-collide', clientId: 'other2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T15:05:00.000Z', endOn: '2026-06-04T15:35:00.000Z', status: 'BOOKED', canceledAt: null };

const SELF_OVERLAP_ON_ADDON_LINE = { code: 'STAFF_DOUBLE_BOOKED', message: 'Appointment is double booked', staffId: 'prov-1', serviceId: 'svc-addon', bookingServiceId: 'bs-addon' };
const SELF_OVERLAP_ON_BASE_LINE = { code: 'STAFF_DOUBLE_BOOKED', message: 'Appointment is double booked', staffId: 'prov-1', serviceId: 'svc-50', bookingServiceId: 'bs-base' };

let calls;
let scanClientIds;

function buildFetch({
  createWarnings = [],
  addOnWarnings = [SELF_OVERLAP_ON_ADDON_LINE],
  completeWarnings = [],
  locationExtraNodes = [],
  collisionScanFails = false,
  contextEndAt = '2026-06-04T15:00:00.000Z', // null -> window underivable -> fail closed
} = {}) {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || '');
    const typeName = String(body?.variables?.typeName || '');
    for (const root of ['bookingCreateFromAppointment', 'bookingAddServiceAddon', 'bookingComplete', 'bookingAddService(', 'bookingRemoveService', 'cancelAppointment', 'appointmentCancel']) {
      if (query.includes(root)) calls.push(root.replace('(', ''));
    }
    if (query.includes('IntrospectType(')) {
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
      if (typeName === 'Appointment') return json({ data: { __type: { fields: ['id','startOn','endOn','clientId','providerId','locationId','status','canceledAt'].map(name => ({ name })) } } });
    }
    if (query.includes('IntrospectTypeDetailed')) {
      if (typeName === 'Appointment') return json({ data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } } });
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments', args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } }, { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } }, { name: 'clientId', type: { kind: 'SCALAR', name: 'ID', ofType: null } }, { name: 'locationId', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } } }, { name: 'query', type: { kind: 'SCALAR', name: 'QueryString', ofType: null } }], type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null } }] } } });
    }
    if (query.includes('FetchAppointmentContext')) {
      return json({ data: { appointment: {
        id: 'appt-1', clientId: 'client-1', locationId: LOC,
        startAt: '2026-06-04T14:00:00.000Z', endAt: contextEndAt, notes: null,
        appointmentServices: [{ id: 'aps-1', serviceId: 'svc-50', staffId: 'prov-1' }],
      } } });
    }
    if (query.includes('FetchServiceContext')) {
      const reqId = String(body?.variables?.id || '');
      if (reqId === 'svc-addon') {
        return json({ data: { service: { id: 'svc-addon', name: 'Antioxidant Peel', addon: true, active: true, defaultDuration: 15, defaultPrice: 5000 } } });
      }
      return json({ data: { service: { id: reqId, name: 'Base Facial', addon: false, active: true, defaultDuration: 50, defaultPrice: 16900 } } });
    }
    if (query.includes('ScanAppointments')) {
      const clientScoped = Boolean(body?.variables?.clientId);
      scanClientIds.push(body?.variables?.clientId || null);
      // Client-scoped scans feed eligibility. Return one appointment BEYOND the
      // 6h evaluation window so the fresh reason is no_upcoming_appointment_in_window,
      // which routes the reverify onto the pendingOffer fallback (canAttemptWithoutGapProof)
      // with currentDurationMinutes from the offer.
      if (clientScoped) {
        const farNode = { ...SOURCE_NODE, id: 'appt-far', startOn: '2026-06-04T20:00:00.000Z', endOn: '2026-06-04T21:00:00.000Z' };
        return json({ data: { appointments: { edges: [{ node: farNode }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (collisionScanFails) return json({ errors: [{ message: 'scan failed' }], data: null });
      const nodes = [SOURCE_NODE, LATER_NODE, ...locationExtraNodes];
      return json({ data: { appointments: { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes('ScanTimeblocks')) {
      return json({ data: { timeblocks: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes('bookingCreateFromAppointment')) {
      return json({ data: { bookingCreateFromAppointment: { booking: {
        id: 'bk-1', bookingClients: [{ id: 'bc-1', clientId: 'client-1' }],
        bookingServices: [{ id: 'bs-base', baseBookingServiceId: null, editingAppointmentServiceId: 'aps-1', serviceId: 'svc-50', staffId: 'prov-1' }],
      }, bookingWarnings: createWarnings } } });
    }
    if (query.includes('bookingAddServiceAddon')) {
      return json({ data: { bookingAddServiceAddon: { booking: { id: 'bk-1' }, bookingService: { id: 'bs-addon', baseBookingServiceId: 'bs-base', serviceId: 'svc-addon', staffId: 'prov-1' }, bookingWarnings: addOnWarnings } } });
    }
    if (query.includes('bookingComplete')) {
      return json({ data: { bookingComplete: { booking: { id: 'bk-1' }, bookingAppointments: [{ appointmentId: 'appt-1', clientId: 'client-1' }], bookingWarnings: completeWarnings } } });
    }
    return json({ data: {} });
  });
}

function env(extra = {}) {
  return {
    ...originalEnv,
    NODE_ENV: 'test',
    BOULEVARD_API_KEY: 'key',
    BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
    BOULEVARD_BUSINESS_ID: 'biz',
    BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
    BOULEVARD_ADDON_SERVICE_ID_ANTIOXIDANT_PEEL: 'svc-addon',
    ...extra,
  };
}

async function runAddonReverify() {
  vi.resetModules();
  const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
  __resetBoulevardCachesForTests();
  return reverifyAndApplyUpgradeForProfile(
    { clientId: 'client-1', tier: null, accountStatus: 'ACTIVE' },
    {
      offerKind: 'addon',
      appointmentId: 'appt-1',
      addOnCode: 'antioxidant_peel',
      addOnName: 'Antioxidant Peel',
      currentDurationMinutes: 50,
      pricing: { memberPrice: 40, walkinPrice: 50, offeredPrice: 50 },
    },
    { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
  );
}

describe('Add-on apply: self-overlap discrimination (mirror of the duration policy)', () => {
  beforeEach(() => { calls = []; scanClientIds = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('PROCEEDS past the benign self-overlap naming the NEW add-on line when the staff window is clear (commits, same appt id)', async () => {
    process.env = env(); global.fetch = buildFetch();
    const result = await runAddonReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied_addon_booking_from_appointment');
    expect(calls).toContain('bookingAddServiceAddon');
    expect(calls).toContain('bookingComplete');
    expect(calls).not.toContain('cancelAppointment');
    expect(calls).not.toContain('appointmentCancel');
    expect(calls).not.toContain('bookingRemoveService');
    // The clear verdict came from an independent location-scoped scan (no clientId).
    expect(scanClientIds).toContain(null);
  });

  it('PROCEEDS past the benign self-overlap naming the edited BASE line on the create gate', async () => {
    process.env = env();
    global.fetch = buildFetch({ createWarnings: [SELF_OVERLAP_ON_BASE_LINE], addOnWarnings: [] });
    const result = await runAddonReverify();
    expect(result.success).toBe(true);
    expect(calls).toContain('bookingComplete');
  });

  it('BLOCKS a genuine collision: another same-staff appointment inside the extended window tail', async () => {
    process.env = env();
    global.fetch = buildFetch({ locationExtraNodes: [COLLIDING_NODE] });
    const result = await runAddonReverify();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('addon_booking_add_service_addon_warning_block');
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when the collision scan errors: the window cannot be proven clear', async () => {
    process.env = env();
    global.fetch = buildFetch({ collisionScanFails: true });
    const result = await runAddonReverify();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('addon_booking_add_service_addon_warning_block');
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when the window end is underivable (context endAt missing)', async () => {
    process.env = env();
    global.fetch = buildFetch({ contextEndAt: null });
    const result = await runAddonReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('BLOCKS RESOURCE_DOUBLE_BOOKED even in a proven-clear window (never a self-overlap)', async () => {
    process.env = env();
    global.fetch = buildFetch({ addOnWarnings: [{ code: 'RESOURCE_DOUBLE_BOOKED', message: 'room busy', staffId: 'prov-1', serviceId: 'svc-addon', bookingServiceId: 'bs-addon' }] });
    const result = await runAddonReverify();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('addon_booking_add_service_addon_warning_block');
    expect(calls).not.toContain('bookingComplete');
  });

  it('BLOCKS a STAFF_DOUBLE_BOOKED naming a line that is neither the base nor the add-on', async () => {
    process.env = env();
    global.fetch = buildFetch({ addOnWarnings: [{ code: 'STAFF_DOUBLE_BOOKED', message: 'double booked', staffId: 'prov-1', serviceId: 'svc-unrelated', bookingServiceId: 'bs-unrelated' }] });
    const result = await runAddonReverify();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('addon_booking_add_service_addon_warning_block');
    expect(calls).not.toContain('bookingComplete');
  });
});
