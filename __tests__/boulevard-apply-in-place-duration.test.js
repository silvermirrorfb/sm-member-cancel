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
// Target upgrade: 50 min. The scanned window end is the MAX of the tier floor
// (start + 50 + PREP_BUFFER_50MIN = 15:00) and the buffer-carried end (endOn + the 20-min
// service delta; the in-place edit keeps the source service's own cleanup buffer, live-proven
// 2026-07-16). With this default service-end endOn (14:30) the floor 15:00 governs.
const SOURCE_NODE = { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null };
// A later same-staff appointment that does NOT overlap the extended window.
const LATER_NODE = { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T16:00:00.000Z', endOn: '2026-06-04T16:30:00.000Z', status: 'BOOKED', canceledAt: null };

// Records every GraphQL operation and the client-scope of each appointment scan so
// tests can assert which mutations ran and that the collision check is a
// location-scoped scan (no clientId), i.e. it reuses scanAppointments.
let calls;
let scanClientIds;
let scanQueries; // window clause (startAt >= ... AND startAt < ...) of each location-scoped scan
let timeblockQueries; // window clause of each ScanTimeblocks query (asserts the fetch window)

// Simulate Boulevard's server-side QueryString filter so a fetch-window bug is observable:
// a node is returned only if it satisfies every (startAt|endAt) (>=|<) 'DATE' clause present
// in the query (ISO date-prefix lexical compare, matching Boulevard's date-granularity filter).
function passesTimeblockQuery(node, query) {
  const q = String(query || '');
  // staffId scoping: a specific non-matching staff is excluded; the target staff (bare-vs-urn
  // normalized) or a null/empty staffId (conservatively, an all-staff block a real backend might
  // surface for any staff query) passes through to the in-memory predicate.
  const staffClause = q.match(/staffId\s*=\s*'([^']+)'/);
  if (staffClause) {
    const bareTail = (s) => String(s == null ? '' : s).split(':').pop();
    const got = bareTail(node?.staffId);
    if (got && got !== bareTail(staffClause[1])) return false;
  }
  const dateClauses = [...q.matchAll(/(startAt|endAt)\s*(>=|<)\s*'([^']+)'/g)];
  return dateClauses.every(([, field, op, date]) => {
    const v = String(node?.[field] || '').slice(0, 10);
    if (!v) return false; // missing field cannot satisfy a bound -> excluded (matches a real filter)
    return op === '>=' ? v >= date : v < date;
  });
}
function buildFetch({
  durationWarnings = [{ code: 'STAFF_DOUBLE_BOOKED', message: 'Appointment is double booked', staffId: 'prov-1', serviceId: 'svc-30', bookingServiceId: 'bs-base' }],
  completeWarnings = [],
  createWarnings = [],
  reject = null,
  locationExtraNodes = [],
  locationExtraNodesSecondCall = null, // nodes for the 2nd location scan (cross-gate rescan)
  omitSourceFromLocationScan = false, // drop the source appt from the collision scan
  sourceEndOn = '2026-06-04T14:30:00.000Z', // booked block end (raw); may be shorter than bucketed duration
  contextEndOn = undefined, // when set, ONLY the apply-path context fetch returns this endAt (eligibility scan keeps sourceEndOn)
  collisionScanFails = false,
  extraContexts = {}, // id -> appointmentServices array (service-level staff), or 'FAIL' to simulate a failed context fetch
  timeblockNodes = [], // staff timeblocks (breaks/time-off) the location-scoped block scan returns (page 1)
  timeblockScanFails = false, // simulate the timeblock query erroring/timing out -> must fail closed
  timeblockTruncated = false, // page 1 reports hasNextPage with NO cursor -> cannot advance -> fail closed
  timeblockNodesPage2 = null, // when set, page 1 hasNextPage->page 2 (cursor 'cur1'); exercises pagination
  timeblockInfinitePages = false, // every page reports hasNextPage+cursor -> runaway -> page-cap fail closed
  timeblockMalformedPage = false, // page 1 returns a non-array edges container -> unparseable -> fail closed
} = {}) {
  let completed = false;
  let locationScanCount = 0;
  const sourceNode = { ...SOURCE_NODE, endOn: sourceEndOn };
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
      if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments', args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } }, { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } }, { name: 'clientId', type: { kind: 'SCALAR', name: 'ID', ofType: null } }, { name: 'locationId', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } } }, { name: 'query', type: { kind: 'SCALAR', name: 'QueryString', ofType: null } }], type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null } }] } } });
    }
    if (query.includes('FetchAppointmentContext')) {
      const reqId = String(body?.variables?.id || '');
      if (reqId && reqId !== 'appt-1' && Object.prototype.hasOwnProperty.call(extraContexts, reqId)) {
        const svc = extraContexts[reqId];
        if (svc === 'FAIL') return json({ data: { appointment: null } });
        return json({ data: { appointment: {
          id: reqId, clientId: 'client-x', locationId: LOC,
          startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', notes: null,
          appointmentServices: svc,
        } } });
      }
      return json({ data: { appointment: {
        id: 'appt-1', clientId: 'client-1', locationId: LOC,
        startAt: '2026-06-04T14:00:00.000Z', endAt: contextEndOn !== undefined ? contextEndOn : sourceEndOn, notes: 'note',
        appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
      } } });
    }
    if (query.includes('ScanAppointments')) {
      const clientScoped = Boolean(body?.variables?.clientId);
      scanClientIds.push(body?.variables?.clientId || null);
      // Client-scoped scan (eligibility) only ever sees the member's own appointments.
      // Location-scoped scan (the collision check) sees the whole location window.
      if (clientScoped) {
        return json({ data: { appointments: { edges: [sourceNode, LATER_NODE].map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      locationScanCount += 1;
      scanQueries.push(String(body?.variables?.query || ''));
      if (collisionScanFails) return json({ errors: [{ message: 'scan failed' }], data: null });
      const extra = (locationScanCount >= 2 && locationExtraNodesSecondCall) ? locationExtraNodesSecondCall : locationExtraNodes;
      const base = omitSourceFromLocationScan ? [LATER_NODE] : [sourceNode, LATER_NODE];
      const nodes = [...base, ...extra];
      return json({ data: { appointments: { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes('ScanTimeblocks')) {
      // Location-scoped staff-timeblock scan (breaks / time-off). Fails closed on error.
      const tbQuery = String(body?.variables?.query || '');
      const after = body?.variables?.after || null;
      if (!after) timeblockQueries.push(tbQuery); // record the window once (page 1)
      if (timeblockScanFails) return json({ errors: [{ message: 'timeblock scan failed' }], data: null });
      // Apply Boulevard's server-side window filter so a too-narrow fetch window drops blocks.
      const filt = (arr) => (arr || []).filter(node => passesTimeblockQuery(node, tbQuery)).map(node => ({ node }));
      if (timeblockInfinitePages) {
        return json({ data: { timeblocks: { edges: filt(timeblockNodes), pageInfo: { hasNextPage: true, endCursor: 'cur-next' } } } });
      }
      if (timeblockMalformedPage) {
        // Structurally successful response, but the node container is not an array and the page
        // claims completeness. A trusting reader would treat it as "no blocks".
        return json({ data: { timeblocks: { edges: null, pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (after === 'cur1') {
        return json({ data: { timeblocks: { edges: filt(timeblockNodesPage2), pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      const hasPage2 = timeblockNodesPage2 !== null;
      const hasNext = hasPage2 ? true : Boolean(timeblockTruncated);
      const cursor = hasPage2 ? 'cur1' : null; // truncated-without-page2 -> null cursor -> caller fails closed
      return json({ data: { timeblocks: { edges: filt(timeblockNodes), pageInfo: { hasNextPage: hasNext, endCursor: cursor } } } });
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
  beforeEach(() => { calls = []; scanClientIds = []; scanQueries = []; timeblockQueries = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
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

  it('does NOT reuse a positive staff-window result across gates: rescans before commit and blocks a collision that appears after setDurations', async () => {
    process.env = env();
    // setDurations self-overlap with a clear window (1st location scan), then the
    // unconditional pre-commit rescan (2nd location scan) finds a real collision.
    // A stale-positive cache would skip the rescan and wrongly commit.
    global.fetch = buildFetch({
      locationExtraNodesSecondCall: [{ id: 'appt-collide', clientId: 'client-2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete'); // blocked BEFORE commit
    // Two location-scoped scans prove the positive result was not cached across gates.
    expect(scanClientIds.filter(id => id === null).length).toBe(2);
  });

  it('blocks a real collision even when Boulevard returns NO staff warning (invariant-triggered, not warning-triggered)', async () => {
    process.env = env();
    // Boulevard surfaces no STAFF_DOUBLE_BOOKED at any gate, yet a real same-staff
    // appointment overlaps the window. The unconditional pre-commit scan must catch
    // it; the safety proof cannot depend on the provider emitting a warning.
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-collide', clientId: 'client-2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when the appointment being edited is absent from its own window scan (untrustworthy scan)', async () => {
    process.env = env();
    global.fetch = buildFetch({ omitSourceFromLocationScan: true });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('detects a collision inside [start, start+target] even when the booked block is shorter than its bucketed duration (window math)', async () => {
    process.env = env();
    // Booked block ends 14:25 (raw 25 min, bucketed to 30). Target 50 => the staff is
    // occupied through 14:50. A collision at 14:46-14:55 must be caught; a window that
    // used endOn + (target - bucketedCurrent) = 14:45 would miss it.
    global.fetch = buildFetch({
      sourceEndOn: '2026-06-04T14:25:00.000Z',
      locationExtraNodes: [{ id: 'appt-collide', clientId: 'client-2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:46:00.000Z', endOn: '2026-06-04T14:55:00.000Z', status: 'BOOKED', canceledAt: null }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('BLOCKS a multi-staff overlapping appointment that carries a service line on the target staff (service-level, not just appointment-level provider)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-ms', clientId: 'client-2', providerId: 'prov-2', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      // Appointment-level provider is prov-2, but one service line is on the target prov-1.
      extraContexts: { 'appt-ms': [{ id: 'aps-ms-1', serviceId: 'svc-a', staffId: 'prov-2' }, { id: 'aps-ms-2', serviceId: 'svc-b', staffId: 'prov-1' }] },
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('does NOT over-block: a genuinely different-staff overlapping appointment (no target service line) still commits', async () => {
    process.env = env();
    global.fetch = buildFetch({
      locationExtraNodes: [{ id: 'appt-other', clientId: 'client-2', providerId: 'prov-2', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      extraContexts: { 'appt-other': [{ id: 'aps-o-1', serviceId: 'svc-a', staffId: 'prov-2' }] },
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingComplete');
  });

  it('FAILS CLOSED when an overlapping appointment’s service staff cannot be resolved', async () => {
    process.env = env();
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-x', clientId: 'client-2', providerId: 'prov-2', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      extraContexts: { 'appt-x': 'FAIL' },
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  // Live Boulevard returns an EMPTY appointment-level providerId in the location
  // scan (only fetchAppointmentContextById resolves the real staff). The gate must
  // resolve the service-line staff for an empty-provider overlap instead of
  // auto-blocking, or every busy-time upgrade fails closed (near no-op).
  it('does NOT over-block: an empty-provider overlapping appointment whose service line is on a DIFFERENT staff still commits', async () => {
    process.env = env();
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-empty', clientId: 'client-2', providerId: null, locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      extraContexts: { 'appt-empty': [{ id: 'aps-e-1', serviceId: 'svc-a', staffId: 'prov-2' }] },
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingComplete');
  });

  it('BLOCKS an empty-provider overlapping appointment that carries a service line on the TARGET staff', async () => {
    process.env = env();
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-empty', clientId: 'client-2', providerId: null, locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      extraContexts: { 'appt-empty': [{ id: 'aps-e-1', serviceId: 'svc-a', staffId: 'prov-2' }, { id: 'aps-e-2', serviceId: 'svc-b', staffId: 'prov-1' }] },
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when an empty-provider overlapping appointment cannot be context-resolved', async () => {
    process.env = env();
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-empty', clientId: 'client-2', providerId: null, locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      extraContexts: { 'appt-empty': 'FAIL' },
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED on an empty-provider overlap whose service lines are ALL unattributable (no resolvable staff at either level)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      durationWarnings: [],
      locationExtraNodes: [{ id: 'appt-empty', clientId: 'client-2', providerId: null, locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
      extraContexts: { 'appt-empty': [{ id: 'aps-e-1', serviceId: 'svc-a', staffId: null }] },
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('collision scan requests the day BEFORE the appointment so a midnight-crossing overlap is not excluded by the date filter', async () => {
    process.env = env();
    global.fetch = buildFetch();
    await runReverify();
    // Source appointment is on 2026-06-04; the collision scan must ask for >= 2026-06-03.
    expect(scanQueries.length).toBeGreaterThan(0);
    expect(scanQueries.some(q => q.includes("startAt >= '2026-06-03'"))).toBe(true);
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

// P1-A (probe-confirmed live 2026-06-25): the in-place apply gate proved the staff
// window clear of OTHER APPOINTMENTS but never consulted staff TIMEBLOCKS. A 30->50
// upgrade extending a real appointment into a staff break/time-off raises
// STAFF_DOUBLE_BOOKED (warning, NOT a hard error) on a window with zero real
// appointments, so the appointment-only scan classified it benign self-overlap and
// committed over the block. The provider-window-clear check must ALSO scan timeblocks
// and fail closed: a non-cancelled overlapping block on the target staff is a real
// collision; any block-fetch failure is treated as NOT clear.
describe('P1-A: timeblock-aware collision gate (staff breaks/time-off are real collisions)', () => {
  beforeEach(() => { calls = []; scanClientIds = []; scanQueries = []; timeblockQueries = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('HEADLINE: aborts before commit when the extended window overlaps a non-cancelled staff timeblock (was wrongly benign)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      // prov-1 break 14:30-15:00 overlaps the extended window [14:00, 14:50]. Appointment scan is clear.
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
    expect(calls).not.toContain('cancelAppointment');
  });

  it('PROCEEDS when the window holds no appointment AND no timeblock (block scan does not over-block)', async () => {
    process.env = env();
    global.fetch = buildFetch({ timeblockNodes: [] });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingComplete');
  });

  it('IGNORES a cancelled timeblock (a cancelled break does not occupy the staff)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Break', cancelled: true }],
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(calls).toContain('bookingComplete');
  });

  it('FAILS CLOSED when the timeblock scan errors (a block-fetch failure must never look benign)', async () => {
    process.env = env();
    global.fetch = buildFetch({ timeblockScanFails: true });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when the timeblock scan is truncated (a second page could hold the overlapping block)', async () => {
    process.env = env();
    // No block on the returned page, but hasNextPage:true means the window was not fully read.
    global.fetch = buildFetch({ timeblockNodes: [], timeblockTruncated: true });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('matches a full-urn block staffId against the bare provider id (bare-vs-urn normalization)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'urn:blvd:Staff:prov-1', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Time off', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('does NOT block a timeblock that abuts the window end but does not overlap it', async () => {
    process.env = env();
    // Window ends 15:00 (the tier floor; service-end endOn 14:30 carries to 14:50, so the floor
    // governs); a block starting exactly 15:00 does not overlap [14:00, 15:00).
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T15:00:00.000Z', endAt: '2026-06-04T15:30:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(calls).toContain('bookingComplete');
  });

  it('does NOT block a timeblock on a DIFFERENT staff (over-block guard)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-2', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(calls).toContain('bookingComplete');
  });

  it('still blocks a genuine cross-client appointment collision (prior fix preserved) with timeblocks empty', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [],
      locationExtraNodes: [{ id: 'appt-collide', clientId: 'client-2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T14:30:00.000Z', endOn: '2026-06-04T15:00:00.000Z', status: 'BOOKED', canceledAt: null }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  // Live-proven 2026-07-16: the in-place upgrade keeps the SAME service and Boulevard keeps that
  // service's own cleanup buffer, so a 30->50 on a 45-min block (endOn = start+45, buffer 15)
  // produces a 65-min block (start+65), NOT the 60-min tier model. The collision window must
  // cover the FULL resulting block: endOn + the 20-min service delta (= start+65 here), not
  // start+60. These pin the previously unscanned [start+60, start+65) tail.
  it('BLOCKS a staff timeblock inside the buffer-carried tail at start+62 (the live-proven 65-min block, previously a blind spot)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      sourceEndOn: '2026-06-04T14:45:00.000Z', // block-end endOn (start+45), as live Boulevard stores it
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T15:02:00.000Z', endAt: '2026-06-04T15:30:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('BLOCKS a cross-client appointment inside the buffer-carried tail at start+62 (previously a blind spot)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      sourceEndOn: '2026-06-04T14:45:00.000Z',
      locationExtraNodes: [{ id: 'appt-tail', clientId: 'client-2', providerId: 'prov-1', locationId: LOC, startOn: '2026-06-04T15:02:00.000Z', endOn: '2026-06-04T15:32:00.000Z', status: 'BOOKED', canceledAt: null }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('does NOT block a timeblock that abuts the buffer-carried end (starts exactly at start+65)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      sourceEndOn: '2026-06-04T14:45:00.000Z',
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T15:05:00.000Z', endAt: '2026-06-04T15:30:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(calls).toContain('bookingComplete');
  });

  // The window-end derivation fails closed (null windowEndOn -> the guard refuses) when the
  // context endOn is missing or unparseable: the full resulting block cannot be proven
  // scanned, so the self-overlap warning must stay blocking. Pins the codex [P2] from the
  // 2026-07-16 gauntlet (a refactor falling back to the tier floor would reopen the tail).
  it('FAILS CLOSED when the apply-path context endOn is unparseable (window end underivable)', async () => {
    process.env = env();
    global.fetch = buildFetch({ contextEndOn: 'not-a-date' });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when the apply-path context endOn is missing (window end underivable)', async () => {
    process.env = env();
    global.fetch = buildFetch({ contextEndOn: '' });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });
});

// Gauntlet hardening (2026-06-26 /codex + /review): cross-model [P1] — the timeblock fetch
// reused the appointment scan's startAt-only, +/-1-day window, so a MULTI-DAY staff block
// (PTO/leave) that STARTED >1 day before the appointment but overlaps the window was never
// fetched -> false-empty -> upgrade committed over the break. Plus fail-open [P2]s: a block
// with unparseable times or a null/all-staff staffId was silently ignored. The mock now
// applies Boulevard's startAt window filter, so the multi-day case is a true red.
describe('P1-A gauntlet hardening: multi-day fetch window + fail-closed predicate', () => {
  beforeEach(() => { calls = []; scanClientIds = []; scanQueries = []; timeblockQueries = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('HEADLINE: blocks a multi-day staff block that STARTED days before the appointment but overlaps the window', async () => {
    process.env = env();
    // PTO 2026-05-30 -> 2026-06-07 overlaps the extended window [14:00, 14:50] on 06-04. A
    // startAt-only +/-1-day fetch window (lower bound 06-03) would never return it.
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-05-30T00:00:00.000Z', endAt: '2026-06-07T00:00:00.000Z', reason: 'PTO', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('fetches timeblocks over a wide lookback window (default 365 days back), not just the +/-1-day appointment window', async () => {
    process.env = env();
    global.fetch = buildFetch();
    await runReverify();
    // Source appointment is 2026-06-04; pagination lets the default lookback reach a full year
    // back to 2025-06-04, so an extended/indefinite block that started long ago is still fetched.
    expect(timeblockQueries.length).toBeGreaterThan(0);
    expect(timeblockQueries.some(q => q.includes("startAt >= '2025-06-04'"))).toBe(true);
  });

  it('respects BOULEVARD_TIMEBLOCK_LOOKBACK_DAYS to widen the fetch window further', async () => {
    process.env = env({ BOULEVARD_TIMEBLOCK_LOOKBACK_DAYS: '60' });
    global.fetch = buildFetch();
    await runReverify();
    // 60 days before 2026-06-04 = 2026-04-05.
    expect(timeblockQueries.some(q => q.includes("startAt >= '2026-04-05'"))).toBe(true);
  });

  it('FAILS CLOSED on a target-staff block with an unparseable endAt (cannot rule out overlap)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T14:30:00.000Z', endAt: 'not-a-date', reason: 'Open hold', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED on an overlapping block with a null/empty staffId (possible all-staff/location closure)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: null, startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Location closed', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED when hasNextPage is a non-boolean truthy value with no cursor (cannot advance)', async () => {
    process.env = env();
    global.fetch = buildFetch({ timeblockNodes: [], timeblockTruncated: 'yes' });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });
});

// Pagination round (2026-06-26 re-gauntlet): the single-page scan failed closed on ANY
// hasNextPage, so a busy location with >1 page of timeblocks in the lookback wrongly aborted
// every legit upgrade. Paginate (the pattern used 4x elsewhere in boulevard.js) so a clear-but-
// large location proceeds, a block on a later page still blocks, and a runaway scan fails closed.
describe('P1-A pagination: multi-page timeblock scan', () => {
  beforeEach(() => { calls = []; scanClientIds = []; scanQueries = []; timeblockQueries = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('PROCEEDS at a busy location: a clear first page with hasNextPage is paged through, not aborted', async () => {
    process.env = env();
    // Page 1 clear + hasNextPage -> page 2 also clear. A single-page scan would fail closed here.
    global.fetch = buildFetch({ timeblockNodes: [], timeblockNodesPage2: [] });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingComplete');
  });

  it('BLOCKS a colliding timeblock that lands on page 2 (not just page 1)', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [],
      timeblockNodesPage2: [{ staffId: 'prov-1', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED on a runaway scan (every page reports hasNextPage) rather than looping or trusting open', async () => {
    process.env = env();
    global.fetch = buildFetch({ timeblockNodes: [], timeblockInfinitePages: true });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('FAILS CLOSED on a malformed-but-successful page (non-array node container) instead of trusting it as empty', async () => {
    process.env = env();
    global.fetch = buildFetch({ timeblockMalformedPage: true });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });
});

// Staff-scoped query (2026-06-26 live probe): a 365-day LOCATION-scoped scan returned >2000
// blocks at Brickell and hit the page cap -> fail closed -> aborted every upgrade. The probe
// confirmed Boulevard supports a staffId filter (646 blocks/7 pages for one staff, terminates),
// and Part 1 found ZERO null-staffId / location-wide closure blocks across 5000 rows at two
// locations, so scoping the query to the target staff alone is sufficient and complete.
describe('P1-A staff-scoped timeblock query', () => {
  beforeEach(() => { calls = []; scanClientIds = []; scanQueries = []; timeblockQueries = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('scopes the timeblock query to the target staff (staffId filter), not the whole location', async () => {
    process.env = env();
    global.fetch = buildFetch();
    await runReverify();
    expect(timeblockQueries.length).toBeGreaterThan(0);
    // The fix reconstructs the canonical staff urn from the provider id (prov-1 in this fixture).
    expect(timeblockQueries.some(q => q.includes("staffId = 'urn:blvd:Staff:prov-1'"))).toBe(true);
  });

  it('a target-staff block still aborts when the query is staff-scoped', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('a different-staff block is not fetched under the staff-scoped query and does not abort', async () => {
    process.env = env();
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-2', startAt: '2026-06-04T14:30:00.000Z', endAt: '2026-06-04T15:00:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(calls).toContain('bookingComplete');
  });
});

// Block-math window (2026-06-29, re-derived 2026-07-16): the scanned window is the MAX of the
// tier floor [start, start + (50 + PREP_BUFFER_50MIN)] = [14:00, 15:00] and the buffer-carried
// end endOn + the 20-min service delta. With this suite's SERVICE-END fixture (endOn = 14:30)
// the carried end is 14:50, so the floor 15:00 governs: a non-cancelled staff block inside
// [14:00, 15:00) is a real collision; one at or after 15:00 is not. (The block-end-endOn case,
// where the carried end 15:05 governs, is pinned in the P1-A suite above.)
describe('block-math collision window: the tier-floor bound with a service-end endOn', () => {
  beforeEach(() => { calls = []; scanClientIds = []; scanQueries = []; timeblockQueries = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env = originalEnv; global.fetch = originalFetch; vi.restoreAllMocks(); });

  it('ABORTS on a staff block at start+55 (14:55), inside the 60-min block but past the 50-min service end', async () => {
    process.env = env();
    // 14:55 is inside [14:00, 15:00) yet OUTSIDE the old service-end window [14:00, 14:50). Under the
    // old service-delta window this upgrade would have committed over a real break (the bug this fixes).
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T14:55:00.000Z', endAt: '2026-06-04T15:25:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(false);
    expect(calls).not.toContain('bookingComplete');
  });

  it('PROCEEDS on a staff block at start+62 (15:02), past the 60-min block end: no over-coverage', async () => {
    process.env = env();
    // With the service-end endOn (14:30) the carried end is 14:50 and the floor 15:00 governs;
    // 15:02 is beyond both, so a window inflating past the floor would false-abort here.
    // Guards the upper bound of the block window for this fixture shape.
    global.fetch = buildFetch({
      timeblockNodes: [{ staffId: 'prov-1', startAt: '2026-06-04T15:02:00.000Z', endAt: '2026-06-04T15:32:00.000Z', reason: 'Break', cancelled: false }],
    });
    const result = await runReverify();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(calls).toContain('bookingComplete');
  });
});
