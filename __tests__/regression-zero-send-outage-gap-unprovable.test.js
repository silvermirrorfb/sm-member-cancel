import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateUpgradeOpportunityForProfile,
  __resetBoulevardCachesForTests,
} from '../src/lib/boulevard.js';

// REGRESSION GUARD for the 2026-06-19 -> 2026-06-22 zero-send outage.
//
// Root cause (see ~/outage-zero-sends-2026-06-21.md, PR #64): the duration-upgrade
// fit check began returning the new skip reason `gap_unprovable` whenever a 30->50
// candidate had NO next booked appointment to bound the gap against. Almost every
// real evening / last-of-day candidate has no next commitment, so ~100% of the
// 30->50 cohort was skipped and sends fell to zero for four days.
//
// This pins the exact real shape from the outage report: a 30-minute booking, no
// next appointment, evening, the salon still open after it, the provider on shift
// past the booking. The fix (PR #71: bound the gap by location close AND provider
// shift end) must make this ELIGIBLE again.
//
//   - On the SHIPPED code at the time of the outage (main @ 3aaa79d) there is no
//     close/shift recovery, so this returns reason 'gap_unprovable', eligible false
//     -> this test FAILS. That is the failing-first proof it reproduces the outage.
//   - With the fix, the gap is bounded by close+shift (30 min to 9 PM, needs 20),
//     so it returns 'eligible' -> this test PASSES.
//
// It imports ONLY the stable public API (evaluateUpgradeOpportunityForProfile) so it
// loads and runs identically against the pre-fix and post-fix boulevard.js.

// Real UWS hours: index 0 = Sunday. Mon-Fri 08:00-21:00, Sat 09:00-19:00, Sun 10:00-18:00.
const HOURS_UWS = [
  { open: true, start: { hour: 10, minute: 0 }, finish: { hour: 18, minute: 0 } }, // 0 Sun
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 1 Mon
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 2 Tue
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 3 Wed
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 4 Thu
  { open: true, start: { hour: 8, minute: 0 }, finish: { hour: 21, minute: 0 } },  // 5 Fri
  { open: true, start: { hour: 9, minute: 0 }, finish: { hour: 19, minute: 0 } },  // 6 Sat
];

const okJson = (data) => ({ ok: true, json: async () => ({ data }) });

function makeFetchMock({ appts, location, shifts }) {
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
    // These two are only reached by the FIXED code's recovery path; on pre-fix code
    // they are never called, which is precisely why the case dies as gap_unprovable.
    if (q.includes('FetchLocationHours')) return okJson({ location });
    if (q.includes('FetchStaffShifts')) return okJson({ shifts: { shifts } });
    return okJson({});
  });
}

// 45-minute slot 7:45 to 8:30 PM ET, which buckets to the 30-minute service (the
// only cohort a 30->50 upgrade applies to). No second appointment after it.
const OUTAGE_SHAPE_APPT = {
  id: 'appt-outage-1', clientId: 'client-outage-1', providerId: 'urn:blvd:Staff:prov-1',
  startOn: '2026-06-19T19:45:00-04:00', endOn: '2026-06-19T20:30:00-04:00',
  locationId: 'urn:blvd:Location:loc-1', status: 'BOOKED', canceledAt: null,
};
const PROFILE = { clientId: 'client-outage-1', tier: '30', accountStatus: 'active' };
const OPTS = { now: '2026-06-19T22:00:00.000Z', windowHours: 12 };

describe('REGRESSION: 2026-06-19 zero-send outage (last-of-day 30->50 died as gap_unprovable)', () => {
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

  it('30->50 member, NO next appointment, evening, salon open + provider on shift -> ELIGIBLE (pre-fix: gap_unprovable, the zero-send bug)', async () => {
    global.fetch = makeFetchMock({
      appts: [OUTAGE_SHAPE_APPT],
      location: { tz: 'America/New_York', hours: HOURS_UWS },
      shifts: [{ staffId: 'prov-1', clockOut: '21:00:00', available: true }],
    });
    const result = await evaluateUpgradeOpportunityForProfile(PROFILE, OPTS);
    // Pre-fix this is { eligible:false, reason:'gap_unprovable' } -> member skipped
    // -> the exact condition that dropped sends to zero for four days.
    expect(result.reason).toBe('eligible');
    expect(result.eligible).toBe(true);
    expect(result.requiredExtraMinutes).toBe(20); // 30 -> 50 (service delta; buffer carries over)
    expect(result.availableGapMinutes).toBe(30);   // 8:30 PM end -> 9:00 PM close/shift
  });
});
