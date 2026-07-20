# TODOS

Deferred work captured during reviews. Each item has enough context to pick up cold.

## HARD GATE: add-on shift-end bypass must be fixed before any add-on flag is enabled

**What:** The add-on offer gate and the add-on apply gate both treat a provider's last-of-day booking as unlimited room and never consult the shift end or location close. A 50-minute booking with no next same-provider commitment in the scan window gets `gapUnlimited: true` from the evaluator's metadata shape; `buildAddonOffer` (src/app/api/sms/automation/pre-appointment/route.js, the `!gapUnlimited` branch of the gap check) and `isAddonGapEligible` (src/lib/boulevard.js, the `gapUnlimited === true` early return) both skip the gap check entirely on that shape.

**Why:** Same disease as the eligibility shift-end bypass fixed in `477b288`, add-on flavor: an add-on could be offered by SMS and applied on YES past the provider's shift end or location close. Dormant today because the add-on flags are off and the `BOULEVARD_ADDON_SERVICE_ID_*` env vars are absent in prod, but nothing in the code path itself refuses.

**HARD GATE:** must be fixed before any add-on flag is enabled. No exceptions.

**Fix direction:** last-of-day add-on room must be proven the same way the duration path now proves it: resolve close/shift via `resolveCloseShiftBoundedGap` and require the add-on minutes to fit within the MINIMUM of (next commitment, location close, provider shift end), failing closed when the bound cannot resolve. This item MERGES with the already-queued add-on block-math review as ONE successor PR, not two.

**Context:** Found by the independent adversarial review of `477b288` (2026-07-20) while verifying the duration-path fix had no remaining bypass. Also see the two codex P2s from the same gauntlet: the QA `upgrade-check` synthetic eligibility mode calls the pure evaluator with no close/shift bound (QA-vs-prod parity drift, read-only, no mutation risk), and a live probe should confirm real scan strategies return `Appointment.locationId` before any flag flip (missing locationId now fails closed, which would silence the duration workload; the zero-send alert would fire).

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
