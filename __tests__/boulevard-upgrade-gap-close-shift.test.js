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
// last UWS booking ends 8:30 PM, UWS closes 9:00 PM, a 30->50 needs 20 min, so
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

  it('Saturday hours (09:00-19:00): 6:30 PM end -> 30 minutes to close', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-20T18:30:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: null });
    expect(g.locationCloseMinutes).toBe(30);
    expect(g.availableGapMinutes).toBe(30);
  });

  it('Sunday hours (10:00-18:00): 5:40 PM end -> 20 minutes to close', () => {
    const g = computeCloseShiftGapMinutes({ endOn: '2026-06-21T17:40:00-04:00', locationTz: 'America/New_York', hours: HOURS_UWS, shiftClockOut: null });
    expect(g.locationCloseMinutes).toBe(20);
    expect(g.availableGapMinutes).toBe(20);
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
    expect(result.requiredExtraMinutes).toBe(20);
  });

  it('BARE staffId from shifts still binds (no urn prefix) and makes it eligible via shift even with no close', async () => {
    const closedFri = HOURS_UWS.map((d, i) => (i === 5 ? { ...d, open: false } : d));
    global.fetch = makeFetchMock({
      appts: [SAMANTHA_APPT],
      location: { tz: 'America/New_York', hours: closedFri },
      shifts: [{ staffId: 'prov-1', clockOut: '21:00:00', available: true }], // bare id; provider is urn:blvd:Staff:prov-1
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(true);
    expect(result.shiftEndMinutes).toBe(30);
    expect(result.gapBoundedBy).toBe('shift_end');
  });

  it('does NOT fit when the salon closes too soon after the booking', async () => {
    const lateAppt = { ...SAMANTHA_APPT, startOn: '2026-06-19T20:05:00-04:00', endOn: '2026-06-19T20:50:00-04:00' }; // ends 8:50 PM
    global.fetch = makeFetchMock({ appts: [lateAppt], location: UWS_LOCATION, shifts: [{ staffId: 'prov-1', clockOut: '21:00:00', available: true }] });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_gap');
    expect(result.availableGapMinutes).toBe(10); // only 10 minutes to 9:00 PM close, needs 20
  });

  it('FAIL-SAFE: when the hours and shift fetches return nothing, stays gap_unprovable (never falsely eligible)', async () => {
    global.fetch = makeFetchMock({ appts: [SAMANTHA_APPT], hoursEmpty: true, shiftsEmpty: true });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('gap_unprovable');
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
