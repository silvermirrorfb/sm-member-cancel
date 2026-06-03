# TODOS

Deferred work captured during reviews. Each item has enough context to pick up cold.

## Verify the in-place upgrade mutation actually changed the appointment

**What:** `tryApplyAppointmentUpgradeMutation` in `src/lib/boulevard.js:2546-2585` treats any returned appointment id as success. It does not re-read the appointment to confirm the service or duration actually changed.

**Why:** If Boulevard accepts the `updateAppointment` / `appointmentUpdate` mutation but no-ops (or changes something unexpected), the duration-upgrade flow still returns `success: true` and the webhook sends the member "You're all set. See you soon." while the booking is unchanged. Silent mismatch between what the member is told and what is booked.

**Pros:** Closes the gap between "mutation accepted" and "duration actually upgraded." Pairs naturally with the move to a single safe apply path.

**Cons:** One extra Boulevard read per successful upgrade (latency, API quota). Needs a decision on what to do when the read shows no change (treat as failure and fail closed, or warn).

**Context:** Surfaced by the codex outside-voice review during `/plan-eng-review` of `docs/superpowers/plans/2026-06-03-duration-upgrade-remove-cancel-rebook-fallback.md`. Deliberately kept OUT of PR A (one fix per PR: PR A is "never cancel," this is "verify the apply"). Start by adding a post-mutation `fetchAppointmentContextById` check that the primary service id now matches the target service id; on mismatch return `upgrade_mutation_failed` so the existing fail-closed routing handles it.

**Depends on / blocked by:** Best landed after PR A (duration cancel-rebook removal) so the single apply path is the only thing to harden.
