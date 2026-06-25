# Spec note: in-place duration upgrade apply (Fix A)

**Date:** 2026-06-25
**Branch:** `fix/apply-in-place-duration` (not merged)
**Scope lock:** the duration-upgrade apply MECHANICS in `src/lib/boulevard.js` (`applyDurationUpgradeViaBooking` plus the reverify verify step) and their tests. No eligibility change (#71), no pricing-resolver change, no flag change. `BOULEVARD_ENABLE_BOOKING_UPGRADE` stays OFF.

## Why

The supervised dry-run (2026-06-25, appointment `af985d32`) showed the add-then-remove booking-edit abort with `STAFF_DOUBLE_BOOKED` at the `bookingRemoveService` step. Root cause: `bookingAddService` creates a second, unlinked service line; removing the editing-linked base line then leaves the new line overlapping the original appointment on the same staff, so Boulevard flags `STAFF_DOUBLE_BOOKED` (a self-overlap), which the code treats as blocking, so every in-place upgrade fail-safes. Read-only introspection confirmed there is no in-place service-swap mutation and no allow-warnings override flag, but `bookingServiceSetDurations` exists.

## Change (mechanics only)

`applyDurationUpgradeViaBooking` now edits the EXISTING editing-linked service line in place:
1. `bookingCreateFromAppointment` (unchanged): opens the draft linked to the appointment.
2. `bookingServiceSetDurations(baseBookingServiceId, duration = target 50)`: extends the same line. (Was: `bookingAddService(50)` + `bookingRemoveService(30)`.)
3. `bookingServiceSetPrice(baseBookingServiceId, quoted total in cents)`: on the SAME line. (Was: on the added line.)
4. `bookingComplete` (unchanged).

No second service line is created, so no `STAFF_DOUBLE_BOOKED` self-overlap; `cancelAppointment` is never called. The booked service stays the same line, extended to 50 min, at the quoted price.

Verification: reverify now confirms the appointment's service line reports the target DURATION (`verifyAppointmentDurationApplied`) instead of a swapped service id (the service id is intentionally unchanged). `targetDurationMinutes` is threaded from the offer.

Kept intact: eligibility gate (#71), tier pricing resolver / quoted-price-honored, #68 de-silenced apply errors. Only the mutation mechanics and the post-apply verification changed.

## Product note
The 50-minute upgrade is now the same booked service extended to 50 minutes, not a swap to a distinct Esthetician's Choice service id. `BOULEVARD_SERVICE_ID_50MIN` is still required by the upstream config gate but is no longer added as a service.

## Tests
- Fix A success: create -> setDurations -> setPrice -> complete; same appointment id; NO `bookingAddService`/`bookingRemoveService`; NO `cancelAppointment`; verify duration 50.
- Genuine `STAFF_DOUBLE_BOOKED` warning still blocks (aborts before complete).
- Any mutation failure aborts before commit (booking untouched).
- Updated the prior add/remove booking-flow test and the apply-error-surface mock to the in-place sequence. Full vitest suite green (969).

## Next (NOT in this PR)
A supervised dry-run on a fresh real test booking (owner with Boulevard open) before `BOULEVARD_ENABLE_BOOKING_UPGRADE` is ever flipped. The flag stays OFF.
