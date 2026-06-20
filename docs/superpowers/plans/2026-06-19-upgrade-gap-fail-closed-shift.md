# Spec note: last-of-day upgrade gap must fail CLOSED when the provider shift is unresolved

**Date:** 2026-06-19
**Branch:** `fix/upgrade-gap-bound-by-close-and-shift` (PR #71, not merged)
**Scope lock:** the gap-bounding logic in `src/lib/boulevard.js` plus its tests. No pricing, no apply path, no flag, no add-on changes.

## Why

PR #71's first cut let the `gap_unprovable` recovery flip `eligible=true` on the **location close bound alone** when the provider shift lookup returned null. Closing time is not proof an esthetician is present to perform a longer service. A gauntlet review (Codex + an independent fresh-context verifier, 9/10) confirmed the fail-OPEN: with location hours resolved and `fetchProviderShiftClockOut` returning null (timeout, GraphQL error, empty rows, or no matching staff row), the code offered anyway. The inline comment claiming "any hours/shift fetch failure ... can never turn an unfittable upgrade eligible" was false for the shift path.

## Locked decision (owner)

When the provider shift end cannot be resolved, the last-of-day upgrade **FAILS CLOSED** (stays `gap_unprovable`, no offer). A missed offer is acceptable; a false offer is not. The recovery may flip `eligible=true` only when **BOTH** a close bound AND a shift bound resolve.

## Changes

1. **Fail closed (Finding 1).** `computeCloseShiftGapMinutes` sets `availableGapMinutes` only when BOTH `locationCloseMinutes` and `shiftEndMinutes` are finite; otherwise null. Individual bounds are still reported for observability. The recovery block flips eligibility only when `availableGapMinutes` is non-null (i.e. both bounds present). Inline comment corrected.
2. **Range-validate wall-clock (Finding 2).** Reject `finish.hour`/`clockOut` hour outside 0-24 and minute outside 0-59 before `Date.UTC`, so a malformed Boulevard value (e.g. `99:99`) cannot roll over into a huge fake-positive gap.
3. **Provider id form (Finding 3) — verified live, READ-ONLY.** Confirmed against production Boulevard: the `shifts()` `staffIds` filter requires the **URN** form (bare errors: "Could not decode global ID"); the response `staffId` is **bare**; the appointment provider id lives at `appointmentServices.staff.id` in **URN-Staff** form; 6/6 sampled staff joined to a shift. The join works in prod. Hardening: normalize the provider id to the Staff URN form before the filter so a stray bare id cannot error the query; keep the bare-vs-bare response match.
4. **Test hardening.** Replace the tautological bare-staffId test (its mock row was already bare, so it passed even with the normalization removed) with one whose `shifts()` row returns a PREFIXED `urn:blvd:Staff:` id, proving the normalization actually binds. Mutation-checked: removing the normalization fails the test.

## Known low-risk follow-ups (noted, NOT in scope)

- **Finding 4 (split shifts):** `fetchProviderShiftClockOut` uses `rows.find()` without checking the shift `[clockIn, clockOut]` actually spans the appointment end; a split-shift day could bind the wrong clockOut. Worst case under the fail-closed rule is under-offering (safe).
- **Next-appointment id-form (boulevard.js next-appt match):** matches provider by exact id; both ids come from the same scan (URN-Staff), so consistent today, but not normalized like the shift match.

## Verification

TDD: the new fail-closed test fails on the old code, passes after the fix. Full vitest suite green (949). Full gauntlet (this spec note, /codex re-run on the final SHA, /review specialists, /cso fail-closed verifier) on the final diff. Merge nothing.

Gauntlet refinements (driven by the gauntlet's own findings, in-scope hardening of items 2-3):
- `isValidWallClock` now rejects hour 24 with a non-zero minute (24:00 = midnight is allowed; 24:30 is not a real time), and close-side minute parsing rejects a garbage minute instead of defaulting it to 0.
- Added a test asserting the outbound `shifts()` `staffIds` variable is the Staff URN even when the appointment provider id is bare (mutation-checked: dropping `toBoulevardStaffUrn` fails it), so the live-verified id form is proven, not assumed.

The /cso fail-closed verifier and an independent review agent both confirmed (9/10) the invariant holds: `eligible=true` is reachable only when BOTH bounds resolve finite. Codex's remaining "block" is the split-shift selection edge (Finding 4), which is the known low-risk follow-up below (worst case under fail-closed is under-offering), not fixed here per scope lock.
