# P1-A: Timeblock-aware in-place duration collision gate

**Date:** 2026-06-26
**Branch:** fix/apply-in-place-duration
**Commit:** 419068f (parent 5bb724c)
**Status:** Committed, NOT merged, flag NOT flipped. Gauntlet-reviewed.

## The bug (probe-confirmed live 2026-06-25)

The in-place duration apply gate proves the staff window clear of OTHER
APPOINTMENTS via `isStaffWindowClearOfOtherAppointments` -> `scanAppointments`,
then treats a `STAFF_DOUBLE_BOOKED` warning as the benign self-overlap of the
edited line whenever that appointment scan is clear.

It never queried staff TIMEBLOCKS (breaks, time-off, holds). A 30->50 upgrade
that extends a real appointment into a staff block raises `STAFF_DOUBLE_BOOKED`
(a WARNING, not a hard error) on a window with zero real appointments, so the
appointment-only scan classified it benign and committed the duration upgrade
over the block. Proven: a fresh draft on a "no appointments" staff block raised
`STAFF_DOUBLE_BOOKED` (warning, not error) on a window with zero appointments.
Boulevard does not fail-safe on its own.

## The fix

`isStaffWindowClearOfOtherAppointments` now ALSO scans the target staff's
timeblocks over the SAME padded window (`scanWindowStart`..`scanWindowEnd`,
including the existing +/-1-day midnight pad; no second uncoordinated window)
and FAILS CLOSED:

- New `scanTimeblocks(apiUrl, headers, {locationId, windowStart, windowEnd})`
  queries root `timeblocks(locationId, query, first)` selecting
  `staffId startAt endAt reason cancelled`, reusing `buildAppointmentWindowQuery`
  (Timeblock filters on `startAt`, same as the appointment scan) and the shared
  `fetchBoulevardGraphQL` executor.
- Returns `{ timeblocks: null }` (fail closed) on transport/GraphQL error, a
  null list, OR a truncated (`hasNextPage`) read.
- In the gate, after the appointment service-level checks pass: a non-cancelled
  timeblock on the target staff (bare-vs-urn normalized) whose `[startAt, endAt)`
  overlaps `[startMs, windowEndMs)` -> window NOT clear -> `return false` ->
  apply aborts before `bookingComplete`. Cancelled blocks ignored. Overlap math
  in epoch-ms / Date.parse, mirroring the appointment scan.

## Scope lock (verified by diff)

Only the collision-gate logic in `boulevard.js` plus tests changed (+187, -0).
Untouched: pricing, the in-place mutation sequence
(create -> setDurations -> setPrice -> complete, no add/remove),
`BOULEVARD_ENABLE_BOOKING_UPGRADE` / `ENABLE_UPGRADE_MUTATION`, the add-on path.
`bookingRemoveService` stays comments-only.

## Tests (red-first, mutation-checked)

`__tests__/boulevard-apply-in-place-duration.test.js` (new describe block):
block-overlap aborts (headline); clear window proceeds; cancelled block ignored;
fetch-failure fails closed; truncated read fails closed; bare-vs-urn block
staffId matches; abutting block does not block; different-staff block does not
block; prior cross-client appointment collision still blocks. Mutation check:
disabling block-overlap detection flips the headline test to failing. Two other
apply-path test mocks taught the new `ScanTimeblocks` query (empty = clear).
Full suite: 996 passing, 3 skipped, 0 failing.

## Gauntlet round (2026-06-26): /codex + /review found a cross-model [P1], fixed

Both Codex and an independent Claude adversarial pass rated ONE finding [P1]
(confidence 9/10): the first commit (419068f) reused the appointment scan's
startAt-only, +/-1-day fetch window for timeblocks. A MULTI-DAY staff block
(PTO/leave) that started >1 day before the appointment but overlaps the window
was never fetched -> false-empty -> upgrade committed over the break. Two
fail-open [P2]s were also flagged (unparseable block times, null staffId).

Fix commit (on top of 419068f):
- Timeblock fetch now uses a wide lookback lower bound (default 30 days,
  `BOULEVARD_TIMEBLOCK_LOOKBACK_DAYS`) so a block that started weeks earlier and
  is still running is fetched. Upper bound unchanged (a block starting after the
  window cannot overlap it).
- Predicate fails closed on: a null/empty `staffId` (possible all-staff or
  location-wide closure), unparseable `startAt`/`endAt` on a target-staff block,
  and any truthy `hasNextPage` (truncation), in addition to the existing
  transport/null-payload fail-closed.
- 6 new red-first tests; the mock now simulates Boulevard's startAt window filter
  so the multi-day case is a true red. Full suite 1002 passing.

TOCTOU between the final pre-commit scan and `bookingComplete` is a pre-existing,
inherent residual of the non-transactional Boulevard API (same for the
appointment-collision path); not introduced here, not fixable without a
transaction. Accepted.

## Pagination round (2026-06-26 re-gauntlet): truncation over-block closed, lookback widened

The re-gauntlet (/codex + independent /review) confirmed all three [P2] fail-OPENs
closed and every change safe-direction, but both models flagged the single-page scan:
a busy location with >1 page of timeblocks in the lookback would fail closed and
wrongly abort legit upgrades. Both recommended pagination (the pattern used 4x in
this file). Fix commit:
- `scanTimeblocks` now PAGINATES the full result set (cursor loop, capped at
  APPOINTMENT_SCAN_MAX_PAGES; a missing cursor or an exhausted cap fails closed).
- With pagination safe, the default lookback widened 30 -> 365 days, shrinking the
  [P1] residual to a block that started >1 year before the appointment and is still
  running (implausible).
- 3 new red-first tests (busy-but-clear location now proceeds; a block on page 2 still
  blocks; a runaway scan fails closed). Full suite 1005 passing.

## Live probe + staff-scoped round (2026-06-26): query shape confirmed, truncation fixed

Read-only probes against LIVE Boulevard (Brickell):
- QUERY SHAPE CONFIRMED. The `timeblocks(locationId, query, first, after)` query the fix
  issues returns HTTP 200 with the expected fields and types: `staffId` (urn string),
  `startAt`/`endAt` (ISO+offset), `cancelled` (boolean). Residual #1 (unverified shape)
  RESOLVED.
- TRUNCATION CONFIRMED AS A BLOCKER. A 365-day LOCATION-scoped scan returned >2000 blocks
  at Brickell and hit the page cap -> fail closed -> would abort every upgrade there. Safe
  but non-functional.
- FIX (staff-scoped query): the live probe confirmed Boulevard supports a `staffId = '...'`
  filter, that it scopes correctly, and that one staff over 365 days is ~646 blocks / 7 pages
  and terminates well under the cap. `scanTimeblocks` now adds `staffId = 'urn:blvd:Staff:<id>'`
  to the query (reconstructed from providerBareId; gate already fails closed on an empty id).
- CLOSURE DECISION (auditable). Part 1 scanned 5000 blocks across Brickell + Coral Gables and
  found ZERO null/empty-staffId blocks (16-19 distinct real staff per location, no closure-
  keyword reasons). SM does NOT model location-wide closures as null-staffId timeblocks, so a
  staff-scoped query is COMPLETE: a closure affecting the target staff would appear as that
  staff's own block. The predicate keeps its null-staffId fail-closed branch defensively (and
  the mock conservatively returns a null-staffId block for any staff query so that safety stays
  tested), but no OR-closure query clause is needed.
- 3 new red-first tests (query is staff-scoped; target-staff block still aborts; different-staff
  block not fetched). Mutation-checked: removing the staffId filter fails the scope test. Full
  suite 1009 passing.

## KNOWN residuals (must resolve before flipping the flag)

1. Block older than the 365-day lookback. A still-running block that STARTED >1 year before the
   appointment is not fetched. Negligible (an over-1-year continuous block).
2. TOCTOU: a block created between the pre-commit scan and `bookingComplete` is not seen.
   Pre-existing, inherent to the non-transactional API. Accepted.
3. Staff-scoped empty-result trust. An empty staff-scoped result is read as "this staff is
   clear". This is sound because the staffId filter is the canonical Boulevard urn (probe-
   confirmed to match real staff); the end-to-end probe below is the final confirmation.

Before flipping `BOULEVARD_ENABLE_BOOKING_UPGRADE`, run the supervised end-to-end probe:
open ONE draft on a test appointment (test client b836d3ef ONLY) positioned to overlap a real
block on its staff, run the shipped apply gate in local-flag-on mode, and confirm it ABORTS
before `bookingComplete` with the timeblock-collision reason. Do NOT call `bookingComplete`;
`cancelAppointment` must never be in the path. Do NOT flip the flag on these commits alone.
