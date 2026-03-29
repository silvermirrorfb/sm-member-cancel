# Upgrade Eligibility & Re-Verification Pipeline — Implementation Summary

**Codebase:** sm-member-cancel (Cancel-Bot-Codex)
**Date:** March 8, 2026
**Status:** Code complete, 39 tests passing, build passing. Mutations gated by `BOULEVARD_ENABLE_UPGRADE_MUTATION=false`.

---

## What Was Built

A real-time appointment upgrade system embedded in the cancellation chatbot. When an identified member has an upcoming appointment with enough provider gap time, the bot can offer an upgrade (30→50 or 50→90 minutes), handle YES/NO replies, re-verify availability on YES, and optionally execute the Boulevard mutation to change the appointment.

The system also triggers proactively: if a member asks a logistics question (directions, parking, etc.), the bot checks for upgrade eligibility and appends the offer to the response.

All upgrade logic runs deterministically in the API route — it does not rely on Claude generating offers or interpreting YES/NO. The LLM handles the conversational flow; the upgrade pipeline handles the math and mutations.

---

## Architecture Overview

```
User message
    │
    ▼
route.js (deterministic fast-paths)
    │
    ├─ Stale offer? → expire pendingUpgradeOffer
    ├─ YES + pending offer? → reverifyAndApplyUpgradeForProfile() → response
    ├─ NO + pending offer? → decline response
    ├─ Upgrade interest keywords? → evaluateUpgradeOpportunityForProfile() → offer
    │
    ▼
Claude LLM response
    │
    ├─ Logistics context detected? → evaluateUpgradeOpportunityForProfile() → proactive offer appended
    │
    ▼
Response to client
```

---

## Files Changed

### `src/lib/boulevard.js` (1,230 lines)

**New constants (lines 17–23):**

| Constant | Default | Env Var |
|----------|---------|---------|
| `APPOINTMENT_SCAN_PAGE_SIZE` | 100 | `BOULEVARD_APPOINTMENT_SCAN_PAGE_SIZE` |
| `APPOINTMENT_SCAN_MAX_PAGES` | 80 | `BOULEVARD_APPOINTMENT_SCAN_MAX_PAGES` |
| `UPGRADE_WINDOW_HOURS` | 6 | `BOULEVARD_UPGRADE_WINDOW_HOURS` |
| `PREP_BUFFER_30MIN` | 15 | `PREP_BUFFER_30MIN` |
| `PREP_BUFFER_50MIN` | 10 | `PREP_BUFFER_50MIN` |
| `PREP_BUFFER_90MIN` | 10 | `PREP_BUFFER_90MIN` |
| `ENABLE_UPGRADE_MUTATION` | false | `BOULEVARD_ENABLE_UPGRADE_MUTATION` |

**New functions:**

- **`bucketDurationMinutes(raw)`** — Snaps raw appointment duration to tier: ≤40→30, ≤70→50, else→90.
- **`prepBufferMinutesForDuration(duration)`** — Returns the prep/turnover buffer for each tier (configurable via env).
- **`pickUpgradeTargetDuration(current)`** — Maps 30→50, 50→90, 90→null (no upgrade path).
- **`computeUpgradePricing(current, target, isMember)`** — Returns `{ walkinTotal, walkinDelta, memberTotal, memberDelta, offeredTotal, offeredDelta }` using `WALKIN_PRICES` and `CURRENT_RATES` lookup tables.
- **`scanAppointments(apiUrl, headers)`** — Paginated Boulevard GraphQL query that introspects the `Appointment` type first (field discovery), then fetches all appointments. Normalizes field names across Boulevard schema variants.
- **`evaluateUpgradeEligibilityFromAppointments(appointments, profile, options)`** — Pure function (no I/O). Finds the member's next upcoming appointment within the window, identifies the provider's next commitment, calculates the available gap (accounting for prep buffer), and returns a detailed eligibility result including pricing.
- **`evaluateUpgradeOpportunityForProfile(profile, options)`** — Orchestrator that calls `scanAppointments()` + `evaluateUpgradeEligibilityFromAppointments()`.
- **`tryApplyAppointmentUpgradeMutation(apiUrl, headers, appointmentId, serviceId)`** — Attempts two mutation shapes (`updateAppointment` and `appointmentUpdate`) for Boulevard schema compatibility. Returns `{ applied, mutationRoot, updatedId }`.
- **`reverifyAndApplyUpgradeForProfile(profile, pendingOffer, options)`** — Full re-verify + apply pipeline: re-runs eligibility for the specific appointment, checks the `ENABLE_UPGRADE_MUTATION` flag, resolves the correct `BOULEVARD_SERVICE_ID_*` for the target duration, and executes the mutation. Returns detailed result with success/failure reason.

### `src/app/api/chat/message/route.js` (922 lines)

**New regex patterns (lines 43–47):**

- `YES_KEYWORDS` — Matches "yes", "yeah", "sure", "ok", "do it", "upgrade", "sounds good", etc.
- `NO_KEYWORDS` — Matches "no", "nah", "pass", "skip", "decline", etc.
- `UPGRADE_INTEREST_KEYWORDS` — Matches "upgrade", "extend", "longer", "50-min", "90-min", "add-on", etc.
- `LOGISTICS_CONTEXT_KEYWORDS` — Matches "directions", "address", "parking", "how do I get", etc.
- `OFFER_WINDOW_MINUTES` — Configurable via `YES_RESPONSE_WINDOW_MIN` (default: 10 minutes).

**New helper functions (lines 166–232):**

- `isAffirmativeUpgradeReply(text)` — YES keyword check.
- `isNegativeUpgradeReply(text)` — NO keyword check.
- `mentionsUpgradeInterest(text)` — Upgrade intent detection.
- `isLogisticsContext(text)` — Logistics question detection.
- `formatTimeForGuest(iso)` — Formats appointment time for guest-facing messages.
- `buildUpgradeOfferMessage(opportunity, { proactive })` — Constructs the upgrade offer with pricing, duration, and YES/NO instructions. Varies opener based on whether the offer is proactive or explicit.
- `buildUpgradeSuccessMessage(result)` — Confirmation message after successful mutation.
- `buildUpgradeUnavailableMessage()` — Fallback when re-verification fails.
- `isPendingOfferExpired(offer)` — Checks if the offer window has elapsed.

**New route logic (lines 642–726, 863–878):**

1. **Stale offer expiration** (line 642): Clears `session.pendingUpgradeOffer` if expired.
2. **YES handling** (line 649): Calls `reverifyAndApplyUpgradeForProfile()`, returns success or unavailable message. Stores `lastUpgradeOfferAppointmentId` to prevent duplicate offers.
3. **NO handling** (line 676): Returns polite decline, clears pending offer.
4. **Explicit upgrade request** (line 694): If member mentions upgrade interest and no pending offer exists, runs eligibility check and presents offer if eligible.
5. **Proactive logistics trigger** (line 864): After Claude responds to a logistics question, checks eligibility and appends offer to the response if eligible.

**Session state additions:**

- `session.pendingUpgradeOffer` — `{ appointmentId, targetDurationMinutes, createdAt, expiresAt }`
- `session.lastUpgradeOfferAppointmentId` — Prevents re-offering the same appointment.

### `.env.example` (lines 70–82)

New config variables documented with defaults:

```
BOULEVARD_APPOINTMENT_SCAN_PAGE_SIZE=100
BOULEVARD_APPOINTMENT_SCAN_MAX_PAGES=80
BOULEVARD_UPGRADE_WINDOW_HOURS=6
YES_RESPONSE_WINDOW_MIN=10
PREP_BUFFER_30MIN=15
PREP_BUFFER_50MIN=10
PREP_BUFFER_90MIN=10
BOULEVARD_ENABLE_UPGRADE_MUTATION=false
BOULEVARD_SERVICE_ID_50MIN=
BOULEVARD_SERVICE_ID_90MIN=
```

### `__tests__/boulevard.test.js` (317 lines)

New test coverage:

- **Eligible gap math** — 30→50 upgrade with sufficient provider gap (25 min available, 20 needed). Verifies pricing delta ($40 member).
- **Ineligible gap math** — Same scenario but provider's next appointment starts too soon (15 min gap, 20 needed). Verifies `reason: 'insufficient_gap'`.
- **Unlimited gap** — No next provider commitment after current appointment. Verifies `gapUnlimited: true`, `availableGapMinutes: null`.
- **Mocked Boulevard integration** — Full `evaluateUpgradeOpportunityForProfile()` with mocked `fetch()` responses for both `IntrospectType` and `ScanAppointments` queries. Verifies end-to-end flow from API call to eligibility result.

---

## Gap Algorithm (The Core Engine)

The eligibility check follows this logic:

1. **Find upcoming appointments** for the member within `UPGRADE_WINDOW_HOURS` (default: 6 hours).
2. **Bucket the current duration** to the nearest tier (30/50/90 minutes).
3. **Pick the upgrade target** (30→50, 50→90).
4. **Calculate required extra minutes** = target − current.
5. **Find the provider's next commitment** after the current appointment ends.
6. **Calculate available gap** = next commitment start − (current end + prep buffer).
7. **Compare**: eligible if `availableGapMinutes ≥ requiredExtraMinutes`.

Prep buffer defaults: 15 min after 30-min facials, 10 min after 50-min, 10 min after 90-min. All configurable via env vars.

---

## Safety Guards

- **Mutation disabled by default** — `BOULEVARD_ENABLE_UPGRADE_MUTATION=false`. No Boulevard writes happen until service IDs are confirmed and the flag is flipped.
- **Re-verification on YES** — Even after a YES reply, the system re-runs the full eligibility check before attempting the mutation. If the gap was taken in the meantime, the guest gets a graceful "no longer available" message.
- **Offer expiration** — Pending offers expire after `YES_RESPONSE_WINDOW_MIN` (default: 10 minutes). Stale offers are cleared on the next message.
- **Duplicate offer prevention** — `lastUpgradeOfferAppointmentId` prevents offering the same appointment twice in one session.
- **Schema-resilient scanning** — `scanAppointments()` introspects the Boulevard `Appointment` type before querying, adapting field names to whatever the schema exposes (`clientId` vs `customerId`, `providerId` vs `staffId`, etc.).
- **Inactive member exclusion** — `isMember` check in eligibility filters out inactive/canceled accounts.

---

## What's Not Wired Yet

Per the spec document (Mirrosa_Upgrade_System_Complete_Spec.docx, Phase 5B v7.0), the full system envisions four tiers of upgrade campaigns (24-hour personalized upsell, 3–6 hour gap-based add-ons, 30-minute pre-appointment upgrades, and empty chair flash sales) plus Klaviyo SMS integration, cooldown/suppression rules, Fitzpatrick safety restrictions, and scheduler jobs.

The current implementation covers the **Tier 3 (pre-appointment upgrade)** path within the chatbot context only. The remaining tiers, SMS outbound, scheduler, and dashboard metrics are future work outside the chatbot codebase.

---

## Suggested QA Scenarios

These are the scenarios to test once Boulevard service IDs are configured:

1. **30→50 eligible** — Member with 30-min appointment, provider has 25+ min gap after.
2. **30→50 ineligible** — Same but gap is only 10 minutes.
3. **50→90 eligible** — Member with 50-min appointment, open schedule after.
4. **No upcoming appointment** — Member with nothing in the next 6 hours.
5. **YES within window** — Offer presented, reply YES within 10 minutes.
6. **YES after window** — Reply YES after offer expires → treated as normal message.
7. **NO reply** — Polite decline, offer cleared.
8. **Proactive logistics trigger** — Member asks "What's the address?" → eligible offer appended.
9. **Duplicate prevention** — Same appointment shouldn't be offered twice.
10. **Inactive member** — Upgrade not offered to inactive/canceled accounts.
11. **Mutation disabled** — With `BOULEVARD_ENABLE_UPGRADE_MUTATION=false`, YES re-verifies but doesn't mutate.
12. **Missing service ID** — Target duration has no configured `BOULEVARD_SERVICE_ID_*` → graceful failure.
