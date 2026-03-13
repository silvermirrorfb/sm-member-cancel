# Silver Mirror Cancel Bot
## Codex Technical Change Log (Takeover Window - Part 3)

Document date: 2026-03-13  
Prepared by: Codex  
Branch: `main`  
Latest commit in this document: `5a78a5d`  
Previous changelog: `docs/CODEX_TECHNICAL_CHANGELOG_2026-03-02_PART2.md` (covers `47cd6b4..f8894bb`)

---

## 1. Scope

This document covers all commits after `061bfda` through `5a78a5d` on `main`.

Resolved git range used for this report:
- `061bfda..5a78a5d` (exclusive of `061bfda`, inclusive of `5a78a5d`)

Commit count in this window:
- `51 commits`

Total delta for this window:
- `28 files changed`
- `9904 insertions`
- `82 deletions`

Files touched in this window:
- `.env.example`
- `__tests__/boulevard-cancel-rebook-notes.test.js`
- `__tests__/boulevard.test.js`
- `__tests__/klaviyo.test.js`
- `__tests__/sms-automation-route.test.js`
- `__tests__/sms-outbound-queue.test.js`
- `__tests__/sms-sessions.test.js`
- `__tests__/sms-window.test.js`
- `__tests__/twilio-webhook-route.test.js`
- `__tests__/twilio.test.js`
- `__tests__/upgrade-check-route.test.js`
- `__tests__/upgrade-route.test.js`
- `docs/LOCATION_ID_REGISTRY.md`
- `docs/OUTBOUND_SMS_DRYRUN_MATRIX_2026-03-09.md`
- `docs/OUTBOUND_SMS_LOGIC_PLAIN_ENGLISH.md`
- `docs/QA_UPGRADE_CHECK_RUNBOOK.md`
- `docs/SMS_Text_Message_Catalog_2026-03-10.csv`
- `src/app/api/chat/message/route.js`
- `src/app/api/qa/upgrade-check/route.js`
- `src/app/api/sms/automation/pre-appointment/route.js`
- `src/app/api/sms/twilio/webhook/route.js`
- `src/lib/boulevard.js`
- `src/lib/klaviyo.js`
- `src/lib/sms-outbound-queue.js`
- `src/lib/sms-sessions.js`
- `src/lib/sms-window.js`
- `src/lib/system-prompt.txt`
- `src/lib/twilio.js`

---

## 2. Executive Summary

Primary outcomes delivered in this window:
- Built the full Boulevard upgrade eligibility pipeline with schema-adaptive appointment scanning and a dedicated QA endpoint.
- Added deterministic SMS upsell automation (pre-appointment sender + inbound Twilio webhook) with send-window controls, queueing, reminder logic, and safety gates.
- Introduced strict production controls for outbound SMS (`SMS_REQUIRE_MANUAL_LIVE_APPROVAL`) and Klaviyo opt-in enforcement (`SMS_REQUIRE_KLAVIYO_OPT_IN`).
- Hardened location normalization and profile resolution for a 10-location operating footprint, including alias/remap strategies.
- Added robust YES/NO handling for SMS upgrade responses, including manual-finalization fallback paths when mutation is disabled or not safe.
- Implemented cancel-rebook mutation fallback for Boulevard upgrade applies, then extended it to preserve appointment notes and emit incident follow-up signals when note sync fails.
- Added substantial QA/test coverage across Boulevard scanning, SMS automation, queueing, webhook behavior, and cancel-rebook note preservation.

---

## 3. Commit Timeline

| Time (ET) | Commit | Summary |
|---|---|---|
| 2026-03-08 21:44 | `3866c11` | Add Boulevard upgrade eligibility pipeline and QA endpoint |
| 2026-03-08 22:30 | `9f98be2` | Add debug diagnostics for Boulevard appointment scan failures |
| 2026-03-08 22:38 | `b317306` | Fallback appointment query roots when Query introspection is unavailable |
| 2026-03-08 22:46 | `b838355` | Support alternate appointment time/provider fields in Boulevard scan |
| 2026-03-08 22:58 | `039a5f4` | Handle nested appointment provider data and improve field diagnostics |
| 2026-03-08 23:05 | `8ad0eeb` | Allow appointment scan without provider id and add conservative fallback |
| 2026-03-09 08:31 | `764995f` | Harden appointment scan root introspection and query fallback |
| 2026-03-09 08:39 | `fea0171` | Pass required appointments locationId from member profile |
| 2026-03-09 11:42 | `ece7a9e` | Tune QA endpoint rate limiting and add location override |
| 2026-03-09 12:41 | `36e2542` | Normalize QA location overrides to Boulevard URN IDs |
| 2026-03-09 12:55 | `aec390a` | Add QA idempotency tracing and location alias fallback |
| 2026-03-09 13:26 | `e661d38` | Add synthetic QA modes for eligibility and lookup fallback |
| 2026-03-09 14:22 | `1c2d6e2` | Add Twilio SMS webhook and pre-appointment automation routes |
| 2026-03-09 15:13 | `ce438f0` | Add SMS send-window guardrails and contact fallback matching |
| 2026-03-09 15:23 | `7224fb0` | Add queued outbound mode for off-hours SMS automation |
| 2026-03-09 15:45 | `17c1b25` | Enforce Klaviyo opt-in and lock live outbound SMS by default |
| 2026-03-09 16:05 | `6743d8f` | Add one-hour upgrade reminder flow with opt-out safeguards |
| 2026-03-09 16:23 | `918afdd` | Fallback to unscoped appointment scan when location scope misses |
| 2026-03-09 16:30 | `d31c482` | Improve duplicate profile matching and location-aware lookup |
| 2026-03-09 16:37 | `0faf0b1` | Prefer requested location during member lookup resolution |
| 2026-03-09 16:41 | `bd6893b` | Tighten name-scan fallback mailbox/location safeguards |
| 2026-03-09 17:19 | `76fd69e` | Fix upgrade scan client binding and pagination fallback |
| 2026-03-10 11:02 | `31b7a03` | Prefer primary location when membership status is inactive |
| 2026-03-10 11:06 | `6a1ce96` | Render outbound appointment times in configured timezone |
| 2026-03-10 11:20 | `1148882` | Harden 10-location canonical mapping and route normalization |
| 2026-03-10 11:39 | `d1a779b` | Harden SMS flows: single-text replies, 10-message web handoff, and duration fix |
| 2026-03-10 11:45 | `f68540a` | Handle inbound YES/NO deterministically for SMS upgrades |
| 2026-03-10 11:55 | `ee4518f` | Improve SMS compaction for coherent single-text replies |
| 2026-03-10 12:06 | `4c4d3ad` | Enforce global SMS cap under 150 with 140-char target |
| 2026-03-10 12:17 | `5788987` | Improve global SMS greeting compaction and tail cleanup |
| 2026-03-10 12:31 | `911c0c5` | Harden upgrade duration inference for guest appointments |
| 2026-03-10 12:35 | `45ed329` | Fail safe on ambiguous multi-appointment upgrades |
| 2026-03-10 12:39 | `81afad9` | Add plain-English outbound SMS logic SOP |
| 2026-03-10 13:03 | `7cccbcc` | Handle non-mutation YES replies with human-finalization messaging |
| 2026-03-10 13:37 | `c2bc4e0` | Short-circuit YES flow when mutation is disabled to prevent Twilio timeout |
| 2026-03-10 13:53 | `62dcbcd` | Fast-path YES replies when mutation is disabled |
| 2026-03-10 14:05 | `0aa596f` | Remove Boulevard wording from guest-facing SMS |
| 2026-03-10 14:16 | `1781c98` | Add member-priced confirmations and SMS add-on offers |
| 2026-03-10 14:41 | `fe10740` | Align SMS upsell flow to latest decision tree |
| 2026-03-10 15:30 | `d2b76ac` | Log SMS upgrade manual follow-up incidents |
| 2026-03-10 16:28 | `c8af8fa` | Prevent disallowed add-on names in SMS confirmations |
| 2026-03-10 16:34 | `b5ad0eb` | Refine SMS style and add a/an grammar for add-ons |
| 2026-03-11 15:26 | `3049433` | Wire cancel/rebook capability probe into QA endpoint |
| 2026-03-11 15:30 | `19fe424` | Trigger production deploy for probe commit |
| 2026-03-11 15:39 | `6797524` | Trigger deploy with team-author identity |
| 2026-03-11 17:28 | `47e7d01` | Fix SMS YES fallback copy and add cancel-rebook upgrade path |
| 2026-03-11 18:42 | `e51d4d5` | Use appointment root to resolve provider for cancel-rebook flow |
| 2026-03-11 19:38 | `deab144` | Use pending offer context for SMS YES reverify flow |
| 2026-03-11 19:43 | `dd2c807` | Fail-safe YES SMS to approved manual confirmation when no eligible slot |
| 2026-03-11 20:44 | `fd523fa` | Force approved YES copy for all failed SMS upgrade applies |
| 2026-03-12 10:57 | `5a78a5d` | Preserve notes in cancel-rebook upgrades and log follow-up |

---

## 4. Detailed Technical Changes (Per Commit)

## 4.1 `3866c11` - Add Boulevard upgrade eligibility pipeline and QA endpoint

### Problem Addressed
There was no deterministic, testable upgrade eligibility engine tied to real Boulevard appointment gaps.

### Specific Code Changes
- Added core upgrade scan/eval functions in `src/lib/boulevard.js`: schema field discovery, appointment scanning, pricing math, and eligibility evaluation (`scanAppointments(...)`, `evaluateUpgradeEligibilityFromAppointments(...)`, `evaluateUpgradeOpportunityForProfile(...)`).
- Added QA read-only endpoint in `src/app/api/qa/upgrade-check/route.js`.
- Added in-chat upgrade offer logic in `src/app/api/chat/message/route.js` (pending-offer state creation and deterministic message path).
- Added matching tests in `__tests__/boulevard.test.js`, `__tests__/upgrade-check-route.test.js`, and `__tests__/upgrade-route.test.js`.
- Added prompt upgrades in `src/lib/system-prompt.txt` and new env settings in `.env.example`.

### Behavioral Impact
The system could now compute whether a same-day 30->50 extension was feasible from real provider gap data.

### Design Decisions / Tradeoffs
Chose schema-introspective query building over hardcoded fields to survive Boulevard schema variance, at the cost of more runtime complexity.

---

## 4.2 `9f98be2` - Add debug diagnostics for Boulevard appointment scan failures

### Problem Addressed
Scan failures were opaque and slow to debug during QA.

### Specific Code Changes
- Added error payload and query-attempt diagnostics in `src/lib/boulevard.js` (`fetchBoulevardGraphQL(...)` + `scanAppointments(...)` diagnostics object).
- Extended QA route debug output in `src/app/api/qa/upgrade-check/route.js` to return structured diagnostics.
- Added debug coverage in `__tests__/boulevard.test.js` and `__tests__/upgrade-check-route.test.js`.

### Behavioral Impact
Failures now report attempted query roots/strategies and compact error details instead of generic failures.

### Design Decisions / Tradeoffs
Preferred verbose diagnostics in QA paths while keeping end-user surfaces generic.

---

## 4.3 `b317306` - Fallback appointment query roots when Query introspection is unavailable

### Problem Addressed
When Query root introspection failed, appointment scans could hard-fail.

### Specific Code Changes
- Added static fallback root strategy logic in `src/lib/boulevard.js` inside `scanAppointments(...)`.
- Added tests in `__tests__/boulevard.test.js` to verify fallback behavior.

### Behavioral Impact
Scans continue with conservative root candidates even when introspection metadata is unavailable.

### Design Decisions / Tradeoffs
Added resilience by trying multiple roots, trading extra API calls for reliability.

---

## 4.4 `b838355` - Support alternate appointment time/provider fields in Boulevard scan

### Problem Addressed
Different environments exposed different appointment field names for start/end/provider.

### Specific Code Changes
- Expanded dynamic field selection in `src/lib/boulevard.js` (`pickFirstAvailableField(...)` usage inside `scanAppointments(...)`).
- Added support for alternate provider object/scalar layouts and time fields.
- Added regression tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Eligibility scanning became robust across field-name variants (for example, `startAt` vs `startOn`).

### Design Decisions / Tradeoffs
Used field-candidate probing instead of environment-specific branching.

---

## 4.5 `039a5f4` - Handle nested appointment provider data and improve field diagnostics

### Problem Addressed
Provider IDs were missing in some payload shapes, causing false ineligibility.

### Specific Code Changes
- Added nested provider introspection/reader helpers in `src/lib/boulevard.js` (`buildProviderNestedPlan(...)`, `readProviderFromNestedPlan(...)`).
- Added richer schema detail cache usage in `getTypeFieldSet(...)` and related helpers.
- Expanded tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Provider extraction succeeded for nested node shapes; diagnostics now identify where extraction failed.

### Design Decisions / Tradeoffs
Chose runtime nested-field planning for portability, with extra query-planning overhead.

---

## 4.6 `8ad0eeb` - Allow appointment scan without provider id and add conservative fallback

### Problem Addressed
Missing provider IDs caused brittle failures and inconsistent outcomes.

### Specific Code Changes
- Updated eligibility logic in `src/lib/boulevard.js` (`evaluateUpgradeEligibilityFromAppointments(...)`) to explicitly return `provider_identity_unavailable` when provider identity is missing.
- Hardened provider-read path in scan helpers.
- Added tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
System fails safe (no offer) when provider identity cannot be trusted.

### Design Decisions / Tradeoffs
Prioritized safety over conversion; avoids unsafe offers at the cost of more false negatives.

---

## 4.7 `764995f` - Harden appointment scan root introspection and query fallback

### Problem Addressed
Root field return-shape differences (connection vs list) caused scan instability.

### Specific Code Changes
- Added deeper type detail helpers in `src/lib/boulevard.js` (`getTypeFieldDetailMap(...)`, return-type handling, strategy extraction hardening).
- Reworked `scanAppointments(...)` strategy selection and paging behavior.
- Added broad test coverage in `__tests__/boulevard.test.js`.

### Behavioral Impact
Scan engine now tolerates more GraphQL root/shape combinations.

### Design Decisions / Tradeoffs
Accepted larger strategy matrix and code complexity to remove hard assumptions about Query schema.

---

## 4.8 `fea0171` - Pass required appointments locationId from member profile

### Problem Addressed
Some root queries required `locationId`; without it, scans failed preflight.

### Specific Code Changes
- Wired profile-driven location into `evaluateUpgradeOpportunityForProfile(...)` and scan context in `src/lib/boulevard.js`.
- Extended root-arg binding logic (`buildRootQueryArgBindings(...)`, `pickQueryContextArgValue(...)`).
- Updated QA endpoint handling in `src/app/api/qa/upgrade-check/route.js`.
- Added tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Queries requiring location context can execute successfully for known-location profiles.

### Design Decisions / Tradeoffs
Used profile location as default query context; this improves success but can miss cross-location bookings (addressed later with fallback).

---

## 4.9 `ece7a9e` - Tune QA endpoint rate limiting and add location override

### Problem Addressed
QA endpoint needed better abuse protection and controlled location targeting.

### Specific Code Changes
- Added explicit rate-limit constants and headers in `src/app/api/qa/upgrade-check/route.js`.
- Added request body location override parsing and now/window parsing updates.
- Added tests in `__tests__/upgrade-check-route.test.js`.

### Behavioral Impact
QA calls are throttled consistently and can target specific locations for reproducible tests.

### Design Decisions / Tradeoffs
Used lightweight in-process limits for speed; not globally shared across instances.

---

## 4.10 `36e2542` - Normalize QA location overrides to Boulevard URN IDs

### Problem Addressed
Location overrides came in mixed formats and could break matching/scans.

### Specific Code Changes
- Added/used location normalization pipeline in `src/lib/boulevard.js` (`resolveBoulevardLocationInput(...)`, canonicalization helpers).
- Applied normalization in `src/app/api/qa/upgrade-check/route.js`.
- Added tests in `__tests__/boulevard.test.js` and `__tests__/upgrade-check-route.test.js`.

### Behavioral Impact
QA location inputs resolve reliably to canonical Boulevard URNs.

### Design Decisions / Tradeoffs
Centralized normalization in library code to avoid route-level duplication.

---

## 4.11 `aec390a` - Add QA idempotency tracing and location alias fallback

### Problem Addressed
Repeated QA requests could produce inconsistent duplicate work and hard-to-trace output.

### Specific Code Changes
- Added request tracing and idempotency cache in `src/app/api/qa/upgrade-check/route.js` (`getRequestId(...)`, `getIdempotencyKey(...)`, `readIdempotencyEntry(...)`, `writeIdempotencyEntry(...)`, replay headers).
- Added location alias fallback and stronger fallback candidate logic in `src/lib/boulevard.js` (alias groups and fallback candidate selection helpers).
- Added tests for idempotency and alias behavior.

### Behavioral Impact
QA endpoint can replay identical idempotent requests and returns stable metadata for debugging.

### Design Decisions / Tradeoffs
In-memory idempotency is fast but non-durable and not shared across serverless instances.

---

## 4.12 `e661d38` - Add synthetic QA modes for eligibility and lookup fallback

### Problem Addressed
Needed deterministic QA paths that do not depend on live Boulevard state.

### Specific Code Changes
- Added `syntheticMode` branches in `src/app/api/qa/upgrade-check/route.js` with separate auth token gate.
- Added synthetic eligibility and lookup payload handling.
- Exported/used supporting library helpers in `src/lib/boulevard.js` for synthetic lookup/profile composition.
- Added tests in `__tests__/upgrade-check-route.test.js`.

### Behavioral Impact
QA can now run deterministic synthetic tests for eligibility and matching logic.

### Design Decisions / Tradeoffs
Kept synthetic mode explicit and token-gated to avoid accidental production misuse.

---

## 4.13 `1c2d6e2` - Add Twilio SMS webhook and pre-appointment automation routes

### Problem Addressed
No production-grade SMS upgrade pipeline existed.

### Specific Code Changes
- Added `src/app/api/sms/automation/pre-appointment/route.js` for outbound offer generation/sending.
- Added `src/app/api/sms/twilio/webhook/route.js` for inbound YES/NO and chat bridge handling.
- Added `src/lib/twilio.js` (signature validation, TwiML builder, send API, message trimming).
- Added `src/lib/sms-sessions.js` (phone-session binding, offer state, reply dedupe).
- Updated docs and initial tests.

### Behavioral Impact
System gained end-to-end SMS automation entry points.

### Design Decisions / Tradeoffs
Used in-memory state for speed and simplicity, accepting serverless durability limits.

---

## 4.14 `ce438f0` - Add SMS send-window guardrails and contact fallback matching

### Problem Addressed
Outbound sends needed time-window compliance and candidate handling hardening.

### Specific Code Changes
- Added `src/lib/sms-window.js` (`isWithinSendWindow(...)`, `getNextWindowStartIso(...)`, timezone parsing helpers).
- Integrated window checks and fallback contact logic into pre-appointment route.
- Updated `docs/OUTBOUND_SMS_DRYRUN_MATRIX_2026-03-09.md` and runbook.
- Added tests in `__tests__/sms-window.test.js` and `__tests__/sms-automation-route.test.js`.

### Behavioral Impact
Automation can skip or defer sends outside local send hours.

### Design Decisions / Tradeoffs
Chose configurable guardrails instead of hardcoded schedule.

---

## 4.15 `7224fb0` - Add queued outbound mode for off-hours SMS automation

### Problem Addressed
Off-hours candidates were being dropped or required manual reruns.

### Specific Code Changes
- Added `src/lib/sms-outbound-queue.js` (`enqueueOutboundCandidate(...)`, `popDueCandidates(...)`, dedupe snapshot helpers).
- Added queue controls in pre-appointment route (`queueWhenOutsideWindow`, `processQueued`, `useQueuedOnly`, `maxQueueDrain`).
- Extended `src/lib/sms-window.js` helper exports.
- Added tests in `__tests__/sms-outbound-queue.test.js` and route tests.

### Behavioral Impact
Candidates can be automatically queued and drained in the next send window.

### Design Decisions / Tradeoffs
Queue is intentionally lightweight and in-memory; resilient enough for controlled automation runs, not durable job infrastructure.

---

## 4.16 `17c1b25` - Enforce Klaviyo opt-in and lock live outbound SMS by default

### Problem Addressed
Needed compliance gates for consent and explicit operator approval before live sends.

### Specific Code Changes
- Added `src/lib/klaviyo.js` consent-check client (`checkKlaviyoSmsOptIn(...)`).
- Wired consent checks + live approval lock into pre-appointment route.
- Added env docs in `.env.example` and runbook updates.
- Added tests in `__tests__/klaviyo.test.js` and `__tests__/sms-automation-route.test.js`.

### Behavioral Impact
Outbound automation fails closed unless consent and live-approval requirements are met.

### Design Decisions / Tradeoffs
Compliance-first defaults reduce accidental sends but increase skipped candidates when dependency data is missing.

---

## 4.17 `6743d8f` - Add one-hour upgrade reminder flow with opt-out safeguards

### Problem Addressed
Single-pass outbound flow missed conversions near appointment time and could repeat too aggressively.

### Specific Code Changes
- Added reminder timing logic in pre-appointment route (`resolveOfferTiming(...)`, reminder lead/tolerance config, "last call before close" mode).
- Added offer-event/cooldown state in `src/lib/sms-sessions.js` (`markUpgradeOfferEvent(...)`, cooldown tracking).
- Updated chat route to mark outcome events on YES/NO.
- Added tests and runbook updates.

### Behavioral Impact
Supports one-hour reminder sends with opt-out/cooldown safeguards.

### Design Decisions / Tradeoffs
More stateful behavior increases complexity but improves control over repeated outreach.

---

## 4.18 `918afdd` - Fallback to unscoped appointment scan when location scope misses

### Problem Addressed
Location-scoped scans could miss real bookings when client primary location differed from actual appointment location.

### Specific Code Changes
- Updated `evaluateUpgradeOpportunityForProfile(...)` in `src/lib/boulevard.js` to retry unscoped scan when scoped result is empty.
- Added tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Eligibility lookup recovers from profile-location drift.

### Design Decisions / Tradeoffs
Added one extra scan fallback path, trading API cost for higher recall.

---

## 4.19 `d31c482` - Improve duplicate profile matching and location-aware lookup

### Problem Addressed
Ambiguous duplicate profiles could resolve to the wrong client.

### Specific Code Changes
- Refined lookup disambiguation heuristics in `src/lib/boulevard.js` (`lookupMember(...)` and related matching flow).
- Added route-level location-aware behavior in pre-appointment automation.
- Added tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Improved chance of selecting the intended client in duplicate-name/contact scenarios.

### Design Decisions / Tradeoffs
Biases toward location-consistent records; may still require manual intervention in highly ambiguous datasets.

---

## 4.20 `0faf0b1` - Prefer requested location during member lookup resolution

### Problem Addressed
Caller-provided location context was underused in final lookup choice.

### Specific Code Changes
- Passed normalized requested location into lookup resolution path.
- Updated QA route to feed location preference into library calls.
- Added tests in `__tests__/upgrade-check-route.test.js`.

### Behavioral Impact
Lookup more consistently matches user-intended location context.

### Design Decisions / Tradeoffs
Location preference can over-bias when provided location is stale/incorrect.

---

## 4.21 `bd6893b` - Tighten name-scan fallback mailbox/location safeguards

### Problem Addressed
Name-scan fallback could select wrong records when mailbox/location confidence was weak.

### Specific Code Changes
- Hardened fallback gating logic in `src/lib/boulevard.js` (`lookupMember(...)` mailbox/location checks).

### Behavioral Impact
Reduced false-positive member matches in weak-identity cases.

### Design Decisions / Tradeoffs
Intentional shift toward false-negative over false-positive for identity safety.

---

## 4.22 `76fd69e` - Fix upgrade scan client binding and pagination fallback

### Problem Addressed
Query-arg binding and paging strategy mismatches could miss eligible appointments.

### Specific Code Changes
- Reworked root strategy builders and argument binding in `src/lib/boulevard.js` (`buildQueryRootStrategies(...)`, `buildRootQueryArgBindings(...)`, `buildScanAppointmentsQuery(...)`, `scanAppointments(...)`).
- Tightened client/location binding and cursor fallback behavior.

### Behavioral Impact
More complete and accurate appointment retrieval under variant schema signatures.

### Design Decisions / Tradeoffs
Strategy engine became broader and more complex but significantly more tolerant of schema differences.

---

## 4.23 `31b7a03` - Prefer primary location when membership status is inactive

### Problem Addressed
Inactive-member location selection could drift to low-quality alternatives.

### Specific Code Changes
- Updated location preference logic in `src/lib/boulevard.js` (`lookupMember(...)`, profile construction flow).

### Behavioral Impact
Inactive records now anchor location preference to primary location when available.

### Design Decisions / Tradeoffs
Improves consistency for inactive accounts but may hide more recent cross-location activity.

---

## 4.24 `6a1ce96` - Render outbound appointment times in configured timezone

### Problem Addressed
Outbound SMS could render appointment times in an unexpected timezone.

### Specific Code Changes
- Updated pre-appointment route time formatter to use configured timezone (`formatTimeForGuest(...)` + usage in message builders).

### Behavioral Impact
Offer and reminder messages display times in business-configured local context.

### Design Decisions / Tradeoffs
Timezone is configurable per run/env, increasing flexibility but requiring careful operational configuration.

---

## 4.25 `1148882` - Harden 10-location canonical mapping and route normalization

### Problem Addressed
Location IDs were inconsistent across APIs, aliases, and human-entered values in a 10-location fleet.

### Specific Code Changes
- Added/expanded canonical location maps and remap parsing in `src/lib/boulevard.js`.
- Normalized location handling in QA and SMS automation routes.
- Updated `docs/LOCATION_ID_REGISTRY.md` and runbook.
- Expanded tests across boulevard, QA route, and automation route.

### Behavioral Impact
Location handling became deterministic and portable across routes.

### Design Decisions / Tradeoffs
Maintains explicit location registry logic in code/docs; requires upkeep as location catalog evolves.

---

## 4.26 `d1a779b` - Harden SMS flows: single-text replies, 10-message web handoff, and duration fix

### Problem Addressed
SMS replies could fragment/overflow, and long SMS threads needed controlled web handoff.

### Specific Code Changes
- Added web-handoff cap behavior in `src/app/api/sms/twilio/webhook/route.js` (`SMS_WEB_HANDOFF_MESSAGE_LIMIT` flow).
- Tightened single-message formatting in chat/webhook offer replies.
- Improved message trimming defaults in `src/lib/twilio.js`.
- Adjusted duration normalization behavior in `src/lib/boulevard.js`.
- Added tests across webhook/twilio/upgrade flow files.

### Behavioral Impact
Cleaner single-text SMS responses, predictable handoff to web chat at message cap, and tighter duration handling.

### Design Decisions / Tradeoffs
Concise copy and hard handoff thresholds improve reliability but can reduce conversational depth in SMS.

---

## 4.27 `f68540a` - Handle inbound YES/NO deterministically for SMS upgrades

### Problem Addressed
YES/NO processing paths were inconsistent between pending offer, fresh opportunity, and mutation states.

### Specific Code Changes
- Added deterministic intent and pending-offer handling in webhook route (`isAffirmative(...)`, `isNegative(...)`, explicit YES/NO branches).
- Added mutation-enabled guard checks and deterministic fallback replies.
- Minor matching hardening in `src/lib/boulevard.js`.
- Added webhook tests.

### Behavioral Impact
Inbound YES/NO outcomes are now predictable and testable.

### Design Decisions / Tradeoffs
Rule-based intent handling favors deterministic outcomes over model-driven interpretation.

---

## 4.28 `ee4518f` - Improve SMS compaction for coherent single-text replies

### Problem Addressed
Compaction could produce awkward/truncated text.

### Specific Code Changes
- Improved rewrite and trimming flow in `src/lib/twilio.js` (`sanitizeSmsText(...)`, `trimSmsBody(...)` adjustments).
- Added tests in `__tests__/twilio.test.js`.

### Behavioral Impact
Compacted messages preserve meaning more reliably while staying short.

### Design Decisions / Tradeoffs
More aggressive rewrite rules increase consistency but can subtly alter wording.

---

## 4.29 `4c4d3ad` - Enforce global SMS cap under 150 with 140-char target

### Problem Addressed
Needed strict SMS length controls to avoid segmentation and carrier issues.

### Specific Code Changes
- Added hard max/target enforcement in `src/lib/twilio.js` (`SMS_MAX_CHARS` and target logic in trim path).
- Added tests in `__tests__/twilio.test.js`.

### Behavioral Impact
Outgoing messages are consistently capped under configured limits.

### Design Decisions / Tradeoffs
Length safety prioritized over full explanatory detail in one message.

---

## 4.30 `5788987` - Improve global SMS greeting compaction and tail cleanup

### Problem Addressed
Trimmed messages retained noisy greeting/tail fragments.

### Specific Code Changes
- Added phrase rewriting and tail cleanup in `src/lib/twilio.js` (`rewriteCommonSmsPhrases(...)` + trim improvements).
- Updated tests in `__tests__/twilio.test.js`.

### Behavioral Impact
Short SMS output reads cleaner and less clipped.

### Design Decisions / Tradeoffs
More rewrite logic means more opinionated formatting behavior.

---

## 4.31 `911c0c5` - Harden upgrade duration inference for guest appointments

### Problem Addressed
Duration bucket inference could misclassify guest appointments with prep/transition buffer.

### Specific Code Changes
- Updated duration inference in `src/lib/boulevard.js` (`bucketDurationMinutes(...)` and related eligibility checks).
- Added tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Eligibility logic better distinguishes base service duration from schedule buffer.

### Design Decisions / Tradeoffs
Heuristic bucketing remains necessary because raw calendar duration can include non-service time.

---

## 4.32 `45ed329` - Fail safe on ambiguous multi-appointment upgrades

### Problem Addressed
Multiple upcoming appointments could lead to wrong-appointment targeting.

### Specific Code Changes
- Added explicit ambiguity guard in `src/lib/boulevard.js` (`multiple_upcoming_appointments_require_appointment_id` path).
- Added tests in `__tests__/boulevard.test.js`.

### Behavioral Impact
Upgrade is blocked unless appointment identity is unambiguous.

### Design Decisions / Tradeoffs
Safety-first guard prevents accidental wrong booking changes but lowers automatic conversion in ambiguous cases.

---

## 4.33 `81afad9` - Add plain-English outbound SMS logic SOP

### Problem Addressed
Ops/QA needed a plain-language source of truth for outbound SMS logic.

### Specific Code Changes
- Added `docs/OUTBOUND_SMS_LOGIC_PLAIN_ENGLISH.md`.

### Behavioral Impact
No runtime effect; improved cross-team clarity and QA reproducibility.

### Design Decisions / Tradeoffs
Documentation-first commit to reduce interpretation drift during rapid iteration.

---

## 4.34 `7cccbcc` - Handle non-mutation YES replies with human-finalization messaging

### Problem Addressed
When mutation was unavailable, YES handling still needed consistent customer-safe confirmation copy.

### Specific Code Changes
- Added explicit non-mutation YES path in webhook route.
- Updated chat route fallback copy builder.
- Added tests in webhook and upgrade route suites.

### Behavioral Impact
Users get immediate approved confirmation text even when upgrade cannot be auto-applied.

### Design Decisions / Tradeoffs
Manual team follow-up path chosen over delayed/error responses.

---

## 4.35 `c2bc4e0` - Short-circuit YES flow when mutation is disabled to prevent Twilio timeout

### Problem Addressed
Webhook could spend too long in unnecessary work when mutation was disabled.

### Specific Code Changes
- Added early-return short-circuit in `src/app/api/sms/twilio/webhook/route.js` for disabled mutation path.
- Added tests in `__tests__/twilio-webhook-route.test.js`.

### Behavioral Impact
Faster webhook responses and lower timeout risk.

### Design Decisions / Tradeoffs
Optimized for Twilio SLA; returns deterministic fallback earlier with less diagnostic processing.

---

## 4.36 `62dcbcd` - Fast-path YES replies when mutation is disabled

### Problem Addressed
Disabled-mutation YES path still had avoidable branch overhead.

### Specific Code Changes
- Moved disabled-mutation YES handling earlier in webhook flow.
- Updated tests accordingly.

### Behavioral Impact
Further reduced webhook latency in disabled-mutation mode.

### Design Decisions / Tradeoffs
Commit doubles down on deterministic "manual finalize" behavior over dynamic opportunity reevaluation.

---

## 4.37 `0aa596f` - Remove Boulevard wording from guest-facing SMS

### Problem Addressed
Guest-facing copy exposed internal provider/system wording.

### Specific Code Changes
- Updated SMS reply text in webhook route to remove Boulevard-specific references.
- Updated language guidance in `src/lib/system-prompt.txt`.
- Updated tests.

### Behavioral Impact
Customer copy is cleaner and brand-consistent.

### Design Decisions / Tradeoffs
Internal implementation details intentionally hidden from customer-facing messages.

---

## 4.38 `1781c98` - Add member-priced confirmations and SMS add-on offers

### Problem Addressed
Upsell flow needed add-on support and clearer member-vs-walk-in pricing communication.

### Specific Code Changes
- Added add-on catalog and offer constructors in pre-appointment route (`buildAddonOffer(...)`, `buildAddonOfferMessage(...)`, `buildOutboundOfferMessage(...)`).
- Added add-on-aware finalization replies in webhook route (`buildPendingOfferFinalizeReply(...)`).
- Updated chat route success/unavailable offer copy to include pricing context.
- Expanded tests across automation/webhook/upgrade route suites.

### Behavioral Impact
Flow supports add-on offers and clearer pricing confirmation paths.

### Design Decisions / Tradeoffs
Introduced more offer branches, increasing state complexity to improve conversion and clarity.

---

## 4.39 `fe10740` - Align SMS upsell flow to latest decision tree

### Problem Addressed
Implementation drifted from the approved decision tree and add-on constraints.

### Specific Code Changes
- Tightened add-on catalog/aliases and offer fallback logic in pre-appointment route.
- Updated upgrade eligibility and offer behavior in `src/lib/boulevard.js` and chat/webhook routes.
- Updated QA route and sms-session event handling to align with decision-tree paths.
- Added broad test updates.

### Behavioral Impact
SMS upsell behavior now matches the approved flow and supported add-on set.

### Design Decisions / Tradeoffs
Deliberately narrowed dynamic behavior to match operational policy.

---

## 4.40 `d2b76ac` - Log SMS upgrade manual follow-up incidents

### Problem Addressed
Manual-upgrade follow-up work had weak operational visibility.

### Specific Code Changes
- Added incident helpers in webhook route (`shouldQueueUpgradeFollowupIncident(...)`, `buildUpgradeSupportIncident(...)`, `queueSupportIncident(...)`).
- Routed fallback/failed upgrade paths to support incident logging.
- Added tests in `__tests__/twilio-webhook-route.test.js`.

### Behavioral Impact
Manual follow-up paths now leave structured incident artifacts.

### Design Decisions / Tradeoffs
Added operational observability at the cost of additional alert/log volume.

---

## 4.41 `c8af8fa` - Prevent disallowed add-on names in SMS confirmations

### Problem Addressed
Unexpected add-on names could leak into customer SMS confirmations.

### Specific Code Changes
- Added strict allowlist in webhook route (`ALLOWED_ADDON_NAME_SET`, `getAllowedAddonDisplayName(...)`).
- Updated catalog source in `docs/SMS_Text_Message_Catalog_2026-03-10.csv`.
- Added tests in webhook suite.

### Behavioral Impact
Only approved add-on labels appear in outbound confirmations.

### Design Decisions / Tradeoffs
Allowlist improves copy control but requires updates when catalog expands.

---

## 4.42 `b5ad0eb` - Refine SMS style and add a/an grammar for add-ons

### Problem Addressed
SMS phrasing needed polish and grammatical correctness for add-on names.

### Specific Code Changes
- Added indefinite-article helpers in pre-appointment and webhook routes (`pickIndefiniteArticle(...)`, `withIndefiniteArticle(...)`).
- Refined offer copy in chat and SMS routes.
- Updated tests in automation/webhook suites.

### Behavioral Impact
Customer-facing SMS reads more natural and consistent.

### Design Decisions / Tradeoffs
Rule-based grammar helper is lightweight but still heuristic for edge pronunciations.

---

## 4.43 `3049433` - Wire cancel/rebook capability probe into QA endpoint

### Problem Addressed
Needed explicit runtime signal of whether Boulevard mutation capabilities were enabled for this app key.

### Specific Code Changes
- Added `probeCancelRebookCapabilities(...)` in `src/lib/boulevard.js` (schema mutation introspection/summarization).
- Exposed probe control and response fields in QA route.
- Added tests in `__tests__/upgrade-check-route.test.js`.

### Behavioral Impact
QA endpoint can now report mutation capability status alongside eligibility output.

### Design Decisions / Tradeoffs
Capability probing kept in QA path only to avoid unnecessary production request overhead.

---

## 4.44 `19fe424` - Trigger production deploy for probe commit

### Problem Addressed
Needed production deployment trigger for the probe changes.

### Specific Code Changes
- No source file changes; deploy trigger commit only.

### Behavioral Impact
No direct code behavior change.

### Design Decisions / Tradeoffs
Operational deploy bookkeeping commit.

---

## 4.45 `6797524` - Trigger deploy with team-author identity

### Problem Addressed
Needed deployment trigger under team-author identity.

### Specific Code Changes
- No source file changes; deploy trigger commit only.

### Behavioral Impact
No runtime behavior change.

### Design Decisions / Tradeoffs
Operational provenance/audit tradeoff over clean linear code-only history.

---

## 4.46 `47e7d01` - Fix SMS YES fallback copy and add cancel-rebook upgrade path

### Problem Addressed
YES fallback copy was inconsistent, and direct appointment update alone was insufficient in some Boulevard environments.

### Specific Code Changes
- Added cancel-rebook fallback implementation in `src/lib/boulevard.js`:
  - `fetchAppointmentContextById(...)`
  - `runMutationRoot(...)`
  - `tryApplyUpgradeViaCancelRebook(...)`
  - `reverifyAndApplyUpgradeForProfile(...)` fallback path.
- Updated webhook fallback copy logic to approved confirmation text.
- Updated chat fallback copy and catalog tests/docs.

### Behavioral Impact
When direct mutation fails, system can attempt cancel + rebook (if fallback gate is enabled) and still return deterministic customer-safe SMS copy.

### Design Decisions / Tradeoffs
Cancel-rebook path was introduced as a controlled fallback, not a default strategy, due higher operational risk compared with in-place mutation.

---

## 4.47 `e51d4d5` - Use appointment root to resolve provider for cancel-rebook flow

### Problem Addressed
Cancel-rebook required reliable staff/provider identity; some contexts lacked provider ID.

### Specific Code Changes
- Enhanced appointment-context/provider resolution in `src/lib/boulevard.js` before fallback mutation apply.
- Updated fallback opportunity merge in `reverifyAndApplyUpgradeForProfile(...)`.

### Behavioral Impact
Higher chance of successful booking reconstruction with correct staff assignment.

### Design Decisions / Tradeoffs
Added extra read path to improve apply safety and reduce wrong-staff booking risk.

---

## 4.48 `deab144` - Use pending offer context for SMS YES reverify flow

### Problem Addressed
YES replies could reverify against the wrong appointment when multiple candidates existed.

### Specific Code Changes
- Updated webhook YES path to prioritize active `pendingUpgradeOffer` appointment/target in reverify call.
- Added tests in `__tests__/twilio-webhook-route.test.js`.

### Behavioral Impact
YES now deterministically maps to the exact offered appointment when pending context exists.

### Design Decisions / Tradeoffs
Pending context improves determinism but can fail if stale, requiring fallback/manual flow.

---

## 4.49 `dd2c807` - Fail-safe YES SMS to approved manual confirmation when no eligible slot

### Problem Addressed
When no eligible slot existed at YES time, copy needed to remain approved and deterministic.

### Specific Code Changes
- Added fail-safe branch in webhook route for no-opportunity/no-pending YES.
- Standardized to approved manual-confirmation text.
- Added tests in webhook suite.

### Behavioral Impact
Customer receives consistent approved confirmation copy even when upgrade cannot be auto-finalized.

### Design Decisions / Tradeoffs
Prioritized approved messaging consistency over exposing granular failure reasons in SMS.

---

## 4.50 `fd523fa` - Force approved YES copy for all failed SMS upgrade applies

### Problem Addressed
Some failure branches still produced variant/non-approved YES fallback text.

### Specific Code Changes
- Consolidated failed-apply YES responses in webhook route to one approved copy path.
- Updated chat fallback phrasing consistency.
- Updated SMS catalog rows and tests.

### Behavioral Impact
All non-success YES outcomes now respond with the approved manual-confirmation language.

### Design Decisions / Tradeoffs
Single-copy strategy improves compliance and QA predictability but removes branch-specific messaging nuance.

---

## 4.51 `5a78a5d` - Preserve notes in cancel-rebook upgrades and log follow-up

### Problem Addressed
Cancel-rebook path risked losing original appointment notes/context on recreated bookings.

### Specific Code Changes
- Extended appointment context fetch to read note fields in `fetchAppointmentContextById(...)`.
- Passed source notes into cancel mutation and fallback opportunity payload in `tryApplyUpgradeViaCancelRebook(...)`.
- Added post-rebook note sync mutation helper `trySyncAppointmentNotes(...)`.
- Surfaced note-sync status in upgrade result (`applied_cancel_rebook_notes_sync_failed` path) and incident logic in webhook route (`shouldQueueUpgradeFollowupIncident(...)`).
- Added regression suite `__tests__/boulevard-cancel-rebook-notes.test.js`.

### Behavioral Impact
Cancel-rebook now attempts to preserve notes end-to-end and emits follow-up signals when note sync fails.

### Design Decisions / Tradeoffs
Preservation is best-effort with explicit follow-up signaling; successful rebook can still complete even if note sync later fails.

---

## 5. Boulevard Appointment Scanning

### Query strategies tried and schema introspection needed
- The scanner moved to schema-adaptive planning rather than fixed query text.
- `scanAppointments(...)` now:
  - introspects Query type (`getSchemaQueryTypeName(...)`),
  - fetches root field metadata (`getTypeFieldDetailMap(...)`),
  - builds strategy plans (`buildQueryRootStrategies(...)`),
  - binds required args (`buildRootQueryArgBindings(...)`) from context (`locationId`, `clientId`),
  - and executes paging variants (`first/after`, `last/before`, connection vs list extraction).
- Field-level introspection supports dynamic selection of appointment time, location, status, cancellation fields, and provider fields.

### Edge cases discovered
- Provider identity may be absent or nested, requiring nested-field provider plans and heuristics.
- Some roots required `locationId`; others were optional; missing required args had to be detected preflight.
- Appointment nodes used mixed field names (`startAt`/`startOn`, provider scalar/object).
- Ambiguous multi-upcoming appointment windows required hard fail unless explicit `appointmentId` is provided.
- Duration math needed to account for prep/transition block inflation.
- Location profile scope could miss real bookings if appointment location differed from primary profile location.

### Fallback chain when introspection fails
1. Try introspected roots and strategy matrix with required-arg bindings.
2. If introspection is partial, use conservative fallback query-root candidates.
3. If scoped-by-location scan returns empty, retry once unscoped for that client.
4. If provider identity remains unresolved, return `provider_identity_unavailable` (no offer).
5. If multiple upcoming appointments exist and none is targeted, return `multiple_upcoming_appointments_require_appointment_id` (no offer).

---

## 6. Upgrade Mutation Flow

### What works, what is gated, what falls back to human confirmation
- Working read path:
  - eligibility scan, pricing, and deterministic offer generation.
- Mutation path is feature-gated:
  - `BOULEVARD_ENABLE_UPGRADE_MUTATION=true` required for auto-apply attempts.
  - service IDs (`BOULEVARD_SERVICE_ID_50MIN`, `BOULEVARD_SERVICE_ID_90MIN`) required for target mapping.
- If mutation is disabled or unsafe:
  - webhook/chat use approved manual confirmation copy and queue incident follow-up for operations.

### Cancel-rebook path: why it exists and when it triggers
- Exists because some Boulevard setups do not support reliable in-place appointment service mutation.
- Trigger conditions in `reverifyAndApplyUpgradeForProfile(...)`:
  - direct apply via `tryApplyAppointmentUpgradeMutation(...)` fails, and
  - `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK=true`.
- Flow:
  - fetch context -> `cancelAppointment` (no client notify) ->
  - `bookingCreate` ->
  - `bookingSetClient` (if needed) ->
  - `bookingAddService` (target service + provider) ->
  - `bookingComplete` (no client notify).

### How notes preservation works in cancel-rebook flow
- Source notes are read from existing appointment context (`fetchAppointmentContextById(...)` with dynamic note-field candidates).
- Cancel mutation writes note text (fallbacks to static automation note only if source note absent).
- After booking completion, `trySyncAppointmentNotes(...)` attempts explicit note write to new appointment.
- Result includes `notesSync` status; if sync fails, success can still return with reason `applied_cancel_rebook_notes_sync_failed`, and webhook incident logging flags manual follow-up.

---

## 7. SMS Automation Decisions

### Why only 4 add-ons in the SMS catalog
- Add-on set intentionally constrained to approved decision-tree items:
  - Antioxidant Peel
  - Neck Firming
  - Eye Puff Minimizer
  - Lip Plump and Scrub
- Enforcement is both generation-time and confirmation-time:
  - pre-appointment route catalog/aliases are fixed,
  - webhook route allowlists display names to prevent drift.

### How the 1-hour reminder flow works
- Pre-appointment route computes timing via `resolveOfferTiming(...)`.
- Scheduled reminder window:
  - default lead 60 min (`SMS_REMINDER_LEAD_MINUTES`),
  - default tolerance +/-15 (`SMS_REMINDER_TOLERANCE_MINUTES`).
- If one-hour mark is outside send window, a same-day "last_call_before_close" path can trigger near end-of-window.
- Reminder YES window is separately constrained (`YES_RESPONSE_WINDOW_REMINDER_MIN` default 10).

### Why 28-day upsell cooldown window
- Cooldown tracking is implemented in `src/lib/sms-sessions.js` (`UPSELL_COOLDOWN_MS = 28 days`).
- Purpose:
  - reduce repeated upsell pressure,
  - avoid over-messaging,
  - preserve trust and compliance posture.

### How the off-hours queue works
- If run occurs outside send window and queueing is enabled:
  - candidates are enqueued with `runAfter` at next allowed send window start.
- Queue is deduped by stable payload key.
- Later runs can drain due work (`processQueued`, `useQueuedOnly`, `maxQueueDrain`).
- Queue state is in-memory (`src/lib/sms-outbound-queue.js`) and intended for controlled operations, not durable job guarantees.

---

## 8. Current Env Var Inventory

### Observed production-state signals (from session artifacts and runtime behavior)
- `BOULEVARD_ENABLE_UPGRADE_MUTATION`:
  - observed disabled/not enabled during March 2026 QA; YES paths were manual confirmation.
- `SMS_REQUIRE_KLAVIYO_OPT_IN`:
  - observed enabled (`true`) in operational notes.
- `SMS_REQUIRE_MANUAL_LIVE_APPROVAL`:
  - observed enabled (`true`) in operational notes.
- `BOULEVARD_API_URL`:
  - set to `https://dashboard.boulevard.io/api/2020-01/admin`.

### Configured vs still needed
- Core required and expected configured:
  - `BOULEVARD_API_KEY`, `BOULEVARD_API_SECRET`, `BOULEVARD_BUSINESS_ID`, `BOULEVARD_API_URL`
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
  - `SMS_AUTOMATION_TOKEN` for protected automation route
  - `QA_UPGRADE_CHECK_TOKEN` for protected QA route
- Needed to unlock auto-upgrade apply:
  - `BOULEVARD_ENABLE_UPGRADE_MUTATION=true`
  - `BOULEVARD_SERVICE_ID_50MIN` (and `BOULEVARD_SERVICE_ID_90MIN` if 90-min flow used)
  - Boulevard app-level mutation permissions (not just env vars), including booking mutation capabilities.
- Needed to unlock cancel-rebook fallback behavior:
  - `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK=true`
  - same booking mutation permissions above.
- Safety/compliance controls (recommended to remain enabled):
  - `SMS_REQUIRE_KLAVIYO_OPT_IN=true`
  - `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=true`

### Feature gates and unlock conditions
- Read-only eligibility scan:
  - unlocked by valid Boulevard auth and appointment scan access.
- Auto-apply mutation:
  - requires mutation env + service IDs + Boulevard permission support.
- Cancel-rebook fallback:
  - requires cancel-rebook gate + booking mutation permissions + provider/location context.
- Synthetic QA modes:
  - require `QA_SYNTHETIC_MODE_TOKEN` when locked down in production.

---

## 9. Known Bugs / Tech Debt

- In-memory state limitations:
  - `sessions`, `sms-sessions`, idempotency cache, and outbound queue are process-local.
  - serverless instance rotation can drop pending offer/queue/idempotency context.
- Phone scan cost at scale:
  - fallback name/phone scanning still has high call volume risk on large client lists.
  - mitigated with page-size/max-page controls but still expensive under heavy usage.
- Schema adaptation complexity:
  - appointment scan reliability depends on introspection paths and dynamic strategies.
  - debugging is better now but code surface is large and sensitive to subtle schema shifts.
- Queue durability:
  - off-hours queue is non-durable by design; suitable for controlled runs but not guaranteed delivery infrastructure.
- Duplicate identity edge cases:
  - heuristics are much stronger, but highly ambiguous profiles can still require manual resolution.

---

## 10. Things That Almost Broke

- Appointment scan root assumptions:
  - early fixed-root assumptions failed against differing Query schemas.
  - resolved by introspected strategy matrix + fallback roots.
- Provider identity extraction:
  - scalar-only assumptions missed nested provider shapes.
  - fixed via nested provider plan + heuristics + explicit safe-fail when unresolved.
- Location scoping:
  - strict location scoping missed real appointments.
  - fixed with one-time unscoped fallback scan.
- YES webhook latency/timeouts:
  - disabled-mutation flow originally did unnecessary work.
  - fixed with short-circuit/fast-path responses.
- Customer copy drift:
  - failure branches emitted non-approved YES text variants.
  - fixed by forcing a single approved manual-confirmation copy for failed applies.
- Cancel-rebook data integrity:
  - note context risked being dropped on recreated bookings.
  - fixed by context note capture + post-rebook note sync + follow-up incident flagging.

---

## Appendix - Key Runtime Functions Introduced/Extended In This Window

- Boulevard scan and eligibility:
  - `scanAppointments(...)`
  - `evaluateUpgradeEligibilityFromAppointments(...)`
  - `evaluateUpgradeOpportunityForProfile(...)`
  - `buildQueryRootStrategies(...)`
  - `buildRootQueryArgBindings(...)`
- Upgrade apply and fallback:
  - `reverifyAndApplyUpgradeForProfile(...)`
  - `tryApplyAppointmentUpgradeMutation(...)`
  - `tryApplyUpgradeViaCancelRebook(...)`
  - `trySyncAppointmentNotes(...)`
  - `probeCancelRebookCapabilities(...)`
- SMS automation:
  - `resolveOfferTiming(...)`
  - `buildDurationOfferMessage(...)`
  - `buildAddonOfferMessage(...)`
  - `enqueueOutboundCandidate(...)` / `popDueCandidates(...)`
- SMS inbound webhook:
  - `buildPendingOfferFinalizeReply(...)`
  - `buildUpgradeApplyReply(...)`
  - `buildUpgradeSupportIncident(...)`
  - deterministic YES/NO pending-offer handling in `POST(...)`.
