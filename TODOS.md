# TODOS

Deferred work captured during reviews. Each item has enough context to pick up cold.

## Close/shift bound is bypassed when a later same-provider commitment exists

**What:** The close+shift gap bounding in `evaluateUpgradeOpportunityForProfile` (src/lib/boulevard.js ~2826) runs ONLY when the reason is `gap_unprovable` (no next same-provider commitment in the scan window). When a next commitment exists, the gap is measured against it alone, and the provider shift end and location close are never consulted.

**Why:** A provider whose next appointment is AFTER their shift end (for example the next morning, inside the ~30h scan window) yields a huge measured gap, so a last-of-day 30->50 upgrade is offered and committed even though it overruns the shift end or location close. Same soft-overrun class the 2026-07-16 live probe confirmed, different trigger shape. Not a double-booking risk: the apply-time collision gate still scans appointments and timeblocks over the full resulting block.

**Fix direction:** When hours/shift data resolves, compute the proven gap as the MINIMUM of (next same-provider commitment, location close, provider shift end), not only as gap_unprovable recovery. Keep the existing fail-closed posture (both bounds must resolve). Add a regression test: next commitment tomorrow morning, shift ends 15 min after the block, expect insufficient_gap.

**Context:** Codex [P1] from the 2026-07-16 block-math gauntlet (the fix that corrected the 15->20 delta and the +65 collision window). Deliberately kept OUT of that scope-locked fix (one fix per PR). The in-code comment at ~2819 ("when a next commitment exists it is already the tightest bound") encodes the false assumption and should be corrected by this fix.

## Verify the in-place upgrade mutation actually changed the appointment

**What:** `tryApplyAppointmentUpgradeMutation` in `src/lib/boulevard.js:2546-2585` treats any returned appointment id as success. It does not re-read the appointment to confirm the service or duration actually changed.

**Why:** If Boulevard accepts the `updateAppointment` / `appointmentUpdate` mutation but no-ops (or changes something unexpected), the duration-upgrade flow still returns `success: true` and the webhook sends the member "You're all set. See you soon." while the booking is unchanged. Silent mismatch between what the member is told and what is booked.

**Pros:** Closes the gap between "mutation accepted" and "duration actually upgraded." Pairs naturally with the move to a single safe apply path.

**Cons:** One extra Boulevard read per successful upgrade (latency, API quota). Needs a decision on what to do when the read shows no change (treat as failure and fail closed, or warn).

**Context:** Surfaced by the codex outside-voice review during `/plan-eng-review` of `docs/superpowers/plans/2026-06-03-duration-upgrade-remove-cancel-rebook-fallback.md`. Deliberately kept OUT of PR A (one fix per PR: PR A is "never cancel," this is "verify the apply"). Start by adding a post-mutation `fetchAppointmentContextById` check that the primary service id now matches the target service id; on mismatch return `upgrade_mutation_failed` so the existing fail-closed routing handles it.

**Depends on / blocked by:** Best landed after PR A (duration cancel-rebook removal) so the single apply path is the only thing to harden.

## Verify whether Klaviyo ever omits the subscriptions key when requested

**What:** `checkKlaviyoSmsOptIn` classifies a profile with no `attributes.subscriptions` key as never-set (non-vetoing). If Klaviyo always includes the key when `additional-fields[profile]=subscriptions` is requested, a missing key signals a malformed payload and should fail closed instead.

**Why:** A payload that silently drops subscription data on page-2+ profiles would classify them as never-set and could fail open behind a page-1 SUBSCRIBED profile. PR #53 already re-appends the additional-fields param on followed pagination links, which closes the known path; this check decides whether the belt also needs suspenders.

**Pros:** One live read-only API call settles it. If the key is always present, the fail-closed guard is a safe two-line addition.

**Cons:** If sparse profiles legitimately omit the key, enforcing the guard would block phones that should pass; needs the live answer first.

**Context:** Deferred decision 4 from the PR #53 review gauntlet (2026-06-10). Adversarial finding F3 and red-team follow-up. Do the live check with a read-only script against a known sparse profile, then decide.

## Escape quotes in the Klaviyo email filter

**What:** `buildFilter` (src/lib/klaviyo.js) interpolates the email into `equals(email,"...")` without quote escaping.

**Why:** Phone takes precedence on every SMS send (digits only, safe), so this only matters for email-keyed checks; a quote in an email likely yields a Klaviyo 400 which fails closed, but a one-line strip closes it cleanly.

**Pros:** One line plus a test. **Cons:** None of note.

**Context:** Pre-existing, surfaced by the Claude adversarial pass during the PR #53 gauntlet (2026-06-10). Out of that PR's scope lock.

## Remove the dead AbortController in unsubscribeKlaviyoSms

**What:** The controller/timeout pair around the profile lookup in `unsubscribeKlaviyoSms` (src/lib/klaviyo.js) is wired to nothing; the lookup goes through `fetchProfileByFilter`, which creates its own controller.

**Why:** Dead code that suggests a timeout exists where it does not.

**Pros:** Pure deletion. **Cons:** None.

**Context:** Pre-existing, surfaced by the maintainability specialist during the PR #53 gauntlet (2026-06-10). Best folded into the named follow-up PR that makes `unsubscribeKlaviyoSms` revoke EVERY profile on the phone on STOP (cited in the PR #53 body).
