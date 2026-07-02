import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  computeCloseShiftGapMinutes,
  zonedWallClockToUtcMs,
  evaluateUpgradeOpportunityForProfile,
  __resetBoulevardCachesForTests,
} from '../src/lib/boulevard.js';

// PR: bound the duration-upgrade gap by the EARLIEST of (next same-provider
// appointment, location close, provider shift end). The provider's last booking
// of the day must not be skipped as gap_unprovable when the salon is open long
// enough after it for the added minutes to fit. Real case: Samantha Lozada's
// last UWS booking ends 8:30 PM, UWS closes 9:00 PM, a 30->50 needs 15 min, so
// it fits and must be ELIGIBLE.

// Real UWS shape: index 0 = Sunday. Mon-Fri 08:00-21:00, Sat 09:00-19:00, Sun 10:00-18:00.
const HOURS_UWS = [
  { open: true, start: { hour: 10, minute: 0 }, finish: { hour: 18, minute: 0 } }, // 0 Sun
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 1 Mon
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 2 Tue
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 3 Wed
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 4 Thu
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 5 Fri
  { open: true, start: { hour: 9, minute: 0 }, finish: { hour: 19, minute: 0 } },  // 6 Sat
];

describe('computeCloseShiftGapMinutes (pure tz-aware gap bounding)', () => {
  it('headline Samantha: Fri 8:30 PM end, UWS close 9:00 PM, shift out 9:00 PM -> exactly 30 minutes', () => {
    const g = computeCloseShiftGapMinutes({
      endOn: '2026-06-19T20:30:00-04:00', // Friday 8:30 PM ET
      locationTz: 'America/New_York',
      hours: HOURS_UWS,
      shiftClockOut: '21:00:00',
    });
    expect(g.locationCloseMinutes).toBe(30);
    expect(g.shiftEndMinutes).toBe(30);
    expect(g.availableGapMinutes).toBe(30);
  });

  it('TIMEZONE: the same instant is interpreted in the location tz, not UTC (off-by-hour guard)', () => {
    const ny = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: null });
    // 8:30 PM to 9:00 PM ET is 30 minutes, never 90 (DST off-by-one) or -30 (UTC date slip)
    expect(ny.locationCloseMinutes).toBe(30);
    // Same wall-clock close (21:00) interpreted in a west-coast tz yields a different
    // number, proving the tz is actually applied rather than ignored.
    const la = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/Los_Angeles', hours: HOURS_UWS, shiftClockOut: null });
    expect(la.locationCloseMinutes).toBe(210);
    expect(la.locationCloseMinutes).not.toBe(ny.locationCloseMinutes);
  });

  it('Saturday hours (09:00-19:00): 6:30 PM end -> 30 minutes to close (close bound only, no shift -> fail closed)', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-20T18:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: null });
    expect(g.locationCloseMinutes).toBe(30);   // Saturday finish 19:00 mapped correctly
    expect(g.availableGapMinutes).toBeNull();  // shift unresolved -> no proven gap
  });

  it('Sunday hours (10:00-18:00): 5:40 PM end -> 20 minutes to close (close bound only, no shift -> fail closed)', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-21T17:40:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: null });
    expect(g.locationCloseMinutes).toBe(20);   // Sunday finish 18:00 mapped correctly
    expect(g.availableGapMinutes).toBeNull();  // shift unresolved -> no proven gap
  });

  it('closed day (open:false) yields no close bound', () => {
    const closedFri = HOURS_UWS.map((d, i) => (i === 5 ? { ...d, open: false } : d));
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: closedFri, shiftClockOut: null });
    expect(g.locationCloseMinutes).toBeNull();
    expect(g.availableGapMinutes).toBeNull();
  });

  it('bounds by the EARLIER of shift end and close (shift ends before close)', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: '20:45:00' });
    expect(g.locationCloseMinutes).toBe(30);
    expect(g.shiftEndMinutes).toBe(15);
    expect(g.availableGapMinutes).toBe(15);
    expect(g.gapBoundedBy).toBe('shift_end');
  });

  it('no hours and no shift -> nothing resolves (caller treats as gap_unprovable)', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: null, shiftClockOut: null });
    expect(g.availableGapMinutes).toBeNull();
  });

  it('FAIL CLOSED: close resolves but shift is null -> availableGapMinutes null (both bounds required)', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: null });
    expect(g.locationCloseMinutes).toBe(30);
    expect(g.shiftEndMinutes).toBeNull();
    expect(g.availableGapMinutes).toBeNull();
  });

  it('FAIL CLOSED: shift resolves but hours missing -> availableGapMinutes null (both bounds required)', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: null, shiftClockOut: '21:00:00' });
    expect(g.shiftEndMinutes).toBe(30);
    expect(g.locationCloseMinutes).toBeNull();
    expect(g.availableGapMinutes).toBeNull();
  });

  it('rejects an out-of-range close hour (99) instead of rolling it into a fake-positive gap', () => {
    const badHours = HOURS_UWS.map((d, i) => (i === 5 ? { ...d, finish: { hour: 99, minute: 0 } } : d));
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: badHours, shiftClockOut: '21:00:00' });
    expect(g.locationCloseMinutes).toBeNull();
    expect(g.availableGapMinutes).toBeNull();
  });

  it('rejects coerced/malformed close hour or minute values (no fake close bound)', () => {
    // Number() would coerce these to valid-looking ints (2e1->20, 0x15->21, 21.0->21,
    // 5e1->50); strictInt must reject them so a malformed close cannot resolve a bound.
    for (const finish of [{ hour: '2e1', minute: 0 }, { hour: '0x15', minute: 0 }, { hour: '21.0', minute: 0 }, { hour: 21, minute: '5e1' }, { hour: 21, minute: '' }, { hour: 21 }]) {
      const badHours = HOURS_UWS.map((d, i) => (i === 5 ? { ...d, finish } : d));
      const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: badHours, shiftClockOut: '21:00:00' });
      expect(g.locationCloseMinutes).toBeNull();
      expect(g.availableGapMinutes).toBeNull();
    }
  });

  it('rejects an out-of-range shift clockOut (99:99) instead of a fake-positive gap', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: '99:99:00' });
    expect(g.shiftEndMinutes).toBeNull();
    expect(g.availableGapMinutes).toBeNull();
  });

  it('rejects 24:30 as a close bound (hour 24 is only valid at :00)', () => {
    const h2430 = HOURS_UWS.map((d, i) => (i === 5 ? { ...d, finish: { hour: 24, minute: 30 } } : d));
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: h2430, shiftClockOut: '21:00:00' });
    expect(g.locationCloseMinutes).toBeNull();
    expect(g.availableGapMinutes).toBeNull();
  });

  it('rejects a clockOut with a valid HH:MM prefix but garbage tail (no fake shift bound)', () => {
    for (const bad of ['21:00:BAD', '21:00:00Z', '21:00 PM', '21:00:0a', '24:00:30', '21:00:00:00', '99:99']) {
      const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: bad });
      expect(g.shiftEndMinutes).toBeNull();
      expect(g.availableGapMinutes).toBeNull();
    }
    // sanity: the well-formed forms still resolve to 30 minutes
    expect(computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: '21:00:00' }).shiftEndMinutes).toBe(30);
    expect(computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: '21:00' }).shiftEndMinutes).toBe(30);
  });

  it('rejects a non-string clockOut (array/number/object) without coercion', () => {
    for (const bad of [['21:00:00'], 2100, { h: 21 }, true]) {
      const g = computeCloseShiftGapMinutes({ endOn: '2026-06-19T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: bad });
      expect(g.shiftEndMinutes).toBeNull();
      expect(g.availableGapMinutes).toBeNull();
    }
  });
});

describe('zonedWallClockToUtcMs DST correctness', () => {
  it('DST-neutral evening: 9:00 PM ET resolves to the correct UTC instant', () => {
    expect(zonedWallClockToUtcMs(2026, 6, 19, 21, 0, 'America/New_York')).toBe(Date.parse('2026-06-20T01:00:00Z'));
  });

  it('spring-forward day: 3:30 AM resolves to 07:30Z (not 08:30Z), two-pass offset fix', () => {
    // 2026-03-08 is US spring-forward; 03:30 exists as EDT (-04:00) -> 07:30 UTC.
    // A naive one-pass offset correction would return 08:30Z (an hour late).
    expect(zonedWallClockToUtcMs(2026, 3, 8, 3, 30, 'America/New_York')).toBe(Date.parse('2026-03-08T07:30:00Z'));
  });

  it('evening on/after the spring-forward day: 8:30 PM end to 9:00 PM close is still exactly 30 minutes', () => {
    // Monday after spring-forward, stable EDT; guards against an off-by-hour close bound.
    const g = computeCloseShiftGapMinutes({ endOn: '2026-03-09T20:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: '21:00:00' });
    expect(g.locationCloseMinutes).toBe(30);
    expect(g.shiftEndMinutes).toBe(30);
    expect(g.availableGapMinutes).toBe(30);
  });
});

// ---- Integration: evaluateUpgradeOpportunityForProfile end to end (mocked Boulevard) ----

const okJson = (data) => ({ ok: true, json: async () => ({ data }) });

function makeFetchMock({ appts, location, shifts, hoursEmpty, shiftsEmpty }) {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = body.query || '';
    if (q.includes('IntrospectType')) {
      const typeName = body?.variables?.typeName;
      if (typeName === 'Query') return okJson({ __type: { fields: [{ name: 'appointments' }] } });
      return okJson({ __type: { fields: ['id', 'startOn', 'endOn', 'clientId', 'providerId', 'locationId', 'status', 'canceledAt'].map((name) => ({ name })) } });
    }
    if (q.includes('ScanAppointments')) {
      return okJson({ appointments: { edges: appts.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (q.includes('FetchLocationHours')) {
      if (hoursEmpty) return okJson({});
      return okJson({ location });
    }
    if (q.includes('FetchStaffShifts')) {
      if (shiftsEmpty) return okJson({});
      return okJson({ shifts: { shifts } });
    }
    return okJson({});
  });
}

const PROFILE = { clientId: 'client-1', tier: '30', accountStatus: 'active' };
const OPTS = { now: '2026-06-19T22:00:00.000Z', windowHours: 12 };
// 45-minute slot (7:45 to 8:30 PM ET) -> buckets to the 30-minute service.
const SAMANTHA_APPT = {
  id: 'appt-1', clientId: 'client-1', providerId: 'urn:blvd:Staff:prov-1',
  startOn: '2026-06-19T19:45:00-04:00', endOn: '2026-06-19T20:30:00-04:00',
  locationId: 'urn:blvd:Location:loc-1', status: 'BOOKED', canceledAt: null,
};
const UWS_LOCATION = { tz: 'America/New_York', hours: HOURS_UWS };

describe('evaluateUpgradeOpportunityForProfile gap bounded by close/shift (mocked)', () => {
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

  it('HEADLINE: last-of-day booking with open salon -> ELIGIBLE bounded by close (was gap_unprovable)', async () => {
    global.fetch = makeFetchMock({ appts: [SAMANTHA_APPT], location: UWS_LOCATION, shifts: [{ staffId: 'prov-1', clockOut: '21:00:00', available: true }] });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.availableGapMinutes).toBe(30);
    expect(result.requiredExtraMinutes).toBe(15);
  });

  it('PREFIXED urn staffId in the shifts response still binds (open day, both bounds) -> eligible', async () => {
    // Real shifts() responses carry a BARE staffId (covered by HEADLINE). This asserts
    // the match ALSO normalizes a PREFIXED urn:blvd:Staff: id, so the bareBoulevardId
    // normalization is load-bearing rather than a tautology. Open day so the close
    // bound also resolves; both bounds present -> eligible. Mutation guard: dropping
    // bareBoulevardId() on the response side leaves the shift unmatched -> fail closed.
    global.fetch = makeFetchMock({
      appts: [SAMANTHA_APPT],
      location: UWS_LOCATION,
      shifts: [{ staffId: 'urn:blvd:Staff:prov-1', clockOut: '21:00:00', available: true }],
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.shiftEndMinutes).toBe(30);
    expect(result.locationCloseMinutes).toBe(30);
  });

  it('sends the Staff URN to the shifts() staffIds filter even when the appointment providerId is bare', async () => {
    // Live Boulevard requires the URN in staffIds (a bare uuid errors). The provider
    // id must be coerced to urn:blvd:Staff:<id> before the filter. Mutation guard:
    // dropping toBoulevardStaffUrn sends the bare id and this assertion fails.
    const bareProvAppt = { ...SAMANTHA_APPT, providerId: 'prov-1' }; // bare provider id
    const fetchMock = makeFetchMock({
      appts: [bareProvAppt],
      location: UWS_LOCATION,
      shifts: [{ staffId: 'prov-1', clockOut: '21:00:00', available: true }], // response is bare
    });
    global.fetch = fetchMock;
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    const shiftCall = fetchMock.mock.calls.find(([, init]) => JSON.parse(init.body).query.includes('FetchStaffShifts'));
    expect(shiftCall).toBeTruthy();
    expect(JSON.parse(shiftCall[1].body).variables.ids).toEqual(['urn:blvd:Staff:prov-1']);
    expect(result.eligible).toBe(true); // URN filter + bare-to-bare response match still binds
  });

  it('does NOT fit when the salon closes too soon after the booking', async () => {
    const lateAppt = { ...SAMANTHA_APPT, startOn: '2026-06-19T20:05:00-04:00', endOn: '2026-06-19T20:50:00-04:00' }; // ends 8:50 PM
    global.fetch = makeFetchMock({ appts: [lateAppt], location: UWS_LOCATION, shifts: [{ staffId: 'prov-1', clockOut: '21:00:00', available: true }] });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.availableGapMinutes).toBe(10); // only 10 minutes to 9:00 PM close, needs 15
  });

  it('FAIL-SAFE: when the hours and shift fetches return nothing, stays gap_unprovable (never falsely eligible)', async () => {
    global.fetch = makeFetchMock({ appts: [SAMANTHA_APPT], hoursEmpty: true, shiftsEmpty: true });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('gap_unprovable');
  });

  it('FAIL-CLOSED: close resolves but the shift has no matching row -> stays gap_unprovable (no offer on close alone)', async () => {
    // Open day, so the location close bound DOES resolve (30 min to 9 PM). The only
    // shift row is for a different staff member, so the provider shift end is
    // unresolved. Closing time alone is not proof the esthetician is present, so the
    // upgrade must NOT be offered. (Pre-fix this returned eligible bounded by close.)
    global.fetch = makeFetchMock({
      appts: [SAMANTHA_APPT],
      location: UWS_LOCATION,
      shifts: [{ staffId: 'someone-else', clockOut: '21:00:00', available: true }],
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.reason).toBe('gap_unprovable');
    expect(result.eligible).toBe(false);
    expect(result.locationCloseMinutes).toBe(30); // close DID resolve
    expect(result.shiftEndMinutes).toBeNull();    // shift did NOT resolve
  });

  it('FAIL-CLOSED: a PREFIXED-urn shift row for a DIFFERENT provider does not match -> stays gap_unprovable', async () => {
    // Booking provider is urn:blvd:Staff:prov-1. The only shift row is a PREFIXED
    // urn for a DIFFERENT staff member, so after URN normalization the booking
    // provider's own shift is still unresolved. The close bound resolves (open
    // day), but close alone must never make the upgrade eligible. This is the
    // exact fail-open hole a6834be closed: flipping eligible on the close bound
    // when the provider shift is unknown.
    global.fetch = makeFetchMock({
      appts: [SAMANTHA_APPT],
      location: UWS_LOCATION,
      shifts: [{ staffId: 'urn:blvd:Staff:prov-OTHER', clockOut: '21:00:00', available: true }],
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.reason).toBe('gap_unprovable');
    expect(result.eligible).toBe(false);
    expect(result.locationCloseMinutes).toBe(30); // close DID resolve
    expect(result.shiftEndMinutes).toBeNull();    // prefixed-urn shift for another provider did NOT
  });

  it('FAIL-CLOSED: close resolves but the shift fetch returns nothing -> gap_unprovable', async () => {
    global.fetch = makeFetchMock({ appts: [SAMANTHA_APPT], location: UWS_LOCATION, shiftsEmpty: true });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.reason).toBe('gap_unprovable');
    expect(result.eligible).toBe(false);
    expect(result.locationCloseMinutes).toBe(30);
    expect(result.shiftEndMinutes).toBeNull();
  });

  it('FAIL-CLOSED: a non-string clockOut in the shift response -> gap_unprovable (no coercion)', async () => {
    global.fetch = makeFetchMock({
      appts: [SAMANTHA_APPT],
      location: UWS_LOCATION,
      shifts: [{ staffId: 'prov-1', clockOut: ['21:00:00'], available: true }], // array, not a string
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.reason).toBe('gap_unprovable');
    expect(result.eligible).toBe(false);
    expect(result.shiftEndMinutes).toBeNull();
  });

  it('FAIL-CLOSED: a split shift (more than one matching shift block) stays gap_unprovable', async () => {
    // The provider has two shift blocks that day. Without clockIn we cannot prove
    // which block covers the 8:30 PM appointment end, and binding the later block
    // (listed first here) would overstate the gap and produce a false offer. The
    // recovery must refuse to guess and fail closed. Pre-fix, rows.find() returned
    // the first (21:00) block and flipped this eligible.
    global.fetch = makeFetchMock({
      appts: [SAMANTHA_APPT],
      location: UWS_LOCATION,
      shifts: [
        { staffId: 'prov-1', clockOut: '21:00:00', available: true },
        { staffId: 'prov-1', clockOut: '13:00:00', available: true },
      ],
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.reason).toBe('gap_unprovable');
    expect(result.eligible).toBe(false);
    expect(result.shiftEndMinutes).toBeNull();
  });

  it('UNCHANGED: a later same-provider appointment still bounds the gap, no hours/shift fetch needed', async () => {
    const nextAppt = { id: 'appt-2', clientId: 'other', providerId: 'urn:blvd:Staff:prov-1', startOn: '2026-06-19T20:50:00-04:00', endOn: '2026-06-19T21:20:00-04:00', locationId: 'urn:blvd:Location:loc-1', status: 'BOOKED', canceledAt: null };
    const fetchMock = makeFetchMock({ appts: [SAMANTHA_APPT, nextAppt], location: UWS_LOCATION, shifts: [] });
    global.fetch = fetchMock;
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.availableGapMinutes).toBe(20); // bounded by the next appointment, not close
    const askedForHours = fetchMock.mock.calls.some(([, init]) => JSON.parse(init.body).query.includes('FetchLocationHours'));
    expect(askedForHours).toBe(false);
  });
});
