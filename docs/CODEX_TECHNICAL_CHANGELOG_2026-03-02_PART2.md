# Silver Mirror Cancel Bot
## Codex Technical Change Log (Takeover Window — Part 2)

Document date: 2026-03-06
Prepared by: Codex
Branch: `main`
Latest commit in this document: `f8894bb`
Previous changelog: `docs/CODEX_TECHNICAL_CHANGELOG_2026-03-02.md` (covers `ac68f1b` through `47cd6b4`)

---

## 1. Scope

This document covers all commits after `47cd6b4` through `f8894bb` on `main`.

Resolved git range used for this report:
- `47cd6b4..f8894bb` (exclusive of `47cd6b4`, inclusive of `f8894bb`)

Total delta for this window:
- `16 files changed`
- `1505 insertions`
- `92 deletions`

Files touched in this window:
- `.env.example`
- `__tests__/fixtures/savings-golden-set.json`
- `docs/CODEX_TECHNICAL_CHANGELOG_2026-03-02.md`
- `docs/SAVINGS_HARNESS.md`
- `package.json`
- `public/chat-launcher-icon.svg`
- `public/embed-snippet.html`
- `public/embed.html`
- `scripts/savings-harness.mjs`
- `src/app/api/chat/end/route.js`
- `src/app/api/chat/message/route.js`
- `src/app/api/chat/start/route.js`
- `src/app/widget/page.js`
- `src/lib/boulevard.js`
- `src/lib/notify.js`
- `src/lib/system-prompt.txt`

---

## 2. Executive Summary

Primary outcomes delivered in this window:
- Fixed the lingering phone-only lookup failure path (BUG14) by removing a schema-incompatible direct query approach and standardizing on paginated scan with env tunables.
- Improved chat UX tone and consistency with deterministic variant phrasing and more empathetic transitions.
- Stabilized end-session logging pipeline (cold-start recovery, correct `INCOMPLETE` outcomes, clean currency/null formatting in sheet/email output).
- Added discount-aware savings logic, first-time promo exclusions, and fallback estimation to improve retention messaging quality.
- Introduced a deterministic savings test harness (`npm run test:savings`) to regression-test `computeValues()` logic.
- Corrected cancellation-close policy in prompt so identified members receive manager handoff + 48-hour confirmation messaging instead of self-serve deflection.
- Added booking/payment incident fast-path that logs to dedicated support sheet and sends QA alert email.
- Added automatic formatting and header enforcement for the support-incident Google Sheet.
- Added cancellation-intent carryover and direct pause-credit FAQ handling to reduce conversational drift and confusion.

---

## 3. Commit Timeline

| Time (ET) | Commit | Summary |
|---|---|---|
| 2026-03-02 18:27 | `2bfe387` | Add technical changelog for Codex takeover changes |
| 2026-03-02 19:15 | `1257134` | Improve phone lookup reliability with direct query fast-path |
| 2026-03-02 19:25 | `91989d3` | Update chat launcher to use new bottom-right icon |
| 2026-03-02 19:33 | `ee8b00b` | Fix BUG14: remove invalid phone query path and tune scan limits |
| 2026-03-02 19:48 | `e05fbac` | Make membership messaging more empathetic and conversational |
| 2026-03-02 20:08 | `39855f7` | Remove cancellation phrase from opening chat message |
| 2026-03-02 20:13 | `517ec14` | Update opening message copy and include time-sensitive help line |
| 2026-03-02 20:36 | `18daccd` | Fix sheet formatting and incomplete-session outcome defaults |
| 2026-03-02 21:24 | `c29e63d` | Harden end-session recovery with client membership context |
| 2026-03-03 07:15 | `08f85c6` | Shorten opening chat greeting copy |
| 2026-03-03 07:31 | `99dc49e` | Add discount-aware savings metrics from Boulevard profile data |
| 2026-03-03 07:44 | `8a3d323` | Exclude first-time promo discounts from member savings totals |
| 2026-03-03 07:48 | `9a2c69a` | Add simple 20% savings fallback and promo exclusion handling |
| 2026-03-03 10:25 | `5d29c5c` | Add savings harness and humanize membership tone transitions |
| 2026-03-03 12:11 | `fb139e7` | Fix cancellation confirmation flow to manager handoff + 48h email |
| 2026-03-03 16:52 | `20f7196` | Add booking incident escalation to QA email and support sheet |
| 2026-03-03 17:01 | `c4b5f64` | Expand issue regex to match verb conjugations |
| 2026-03-03 17:52 | `1da0472` | Auto-apply support sheet headers and formatting for website bugs |
| 2026-03-05 13:53 | `f8894bb` | Fix cancellation intent carryover, inactive flow, and pause credits FAQ |

---

## 4. Detailed Technical Changes (Per Commit)

## 4.1 `2bfe387` — Add technical changelog for Codex takeover changes

### Problem Addressed
No durable engineering narrative existed for the first post-takeover changes.

### Specific Code Changes
- Added `docs/CODEX_TECHNICAL_CHANGELOG_2026-03-02.md`.

### Behavioral Impact
- No runtime change.
- Improved handoff continuity and future debugging context.

### Design Decisions / Tradeoffs
- Chose in-repo Markdown changelog over external notes to keep versioned rationale tied to code state.

---

## 4.2 `1257134` — Improve phone lookup reliability with direct query fast-path

### Problem Addressed
Phone-only lookup latency/failure risk was high when scanning full client lists.

### Specific Code Changes
In `src/lib/boulevard.js`:
- Added `PHONE_SCAN_FALLBACK_PAGES`.
- Added `findClientsByPhoneDirect(apiUrl, headers, cleanPhone)` using GraphQL `clients(query: $query)`.
- Added phone query variants for normalized numbers (`1XXXXXXXXXX`, local 10-digit, `+1...`, `+...`).
- Updated `findClientsByPhoneScan` to support configurable `maxPages` argument.
- Updated `lookupMember(...)` flow:
  - try direct query first,
  - if direct returns empty, do smaller fallback scan,
  - if direct unsupported, do full scan.

### Behavioral Impact
- Intended to reduce scan pressure and speed phone matches when Boulevard query path worked.

### Design Decisions / Tradeoffs
- Performance-first experiment: optimistic direct query before expensive scan.
- Tradeoff: depended on a GraphQL query capability that later proved unreliable in production schema.

---

## 4.3 `91989d3` — Update chat launcher to use new bottom-right icon

### Problem Addressed
User requested replacement of launcher icon in embed implementations.

### Specific Code Changes
- Added `public/chat-launcher-icon.svg`.
- Updated icon references in:
  - `public/embed.html`
  - `public/embed-snippet.html`
- Replaced previous `sm-logo.jpg` references with `chat-launcher-icon.svg`.

### Behavioral Impact
- Chat launcher visual updated across embed variants.

### Design Decisions / Tradeoffs
- Used SVG asset for consistent scaling and lower payload than raster image.

---

## 4.4 `ee8b00b` — Fix BUG14: remove invalid phone query path and tune scan limits

### Problem Addressed
Direct-query phone path introduced in `1257134` generated Boulevard GraphQL argument errors in production and caused false “not found” outcomes.

### Specific Code Changes
In `src/lib/boulevard.js`:
- Removed `findClientsByPhoneDirect(...)` entirely.
- Reverted `lookupMember(...)` phone path to scan-only.
- Removed `PHONE_SCAN_FALLBACK_PAGES` logic.
- Made scan limits env-configurable:
  - `BOULEVARD_PHONE_SCAN_PAGE_SIZE` (default 100)
  - `BOULEVARD_PHONE_SCAN_MAX_PAGES` (default 300)

In `.env.example`:
- Documented scan tuning variables.

### Behavioral Impact
- Eliminated repeated GraphQL query-path errors.
- Restored deterministic phone matching through scan path.
- Increased upper-bound scan depth for large client datasets.

### Design Decisions / Tradeoffs
- Chose reliability over speed.
- Accepted heavier scan cost to avoid schema-specific query breakage.

---

## 4.5 `e05fbac` — Make membership messaging more empathetic and conversational

### Problem Addressed
Post-lookup messaging felt templated/robotic and overly transactional.

### Specific Code Changes
In `src/app/api/chat/message/route.js`:
- Refined `buildPostLookupGreeting(...)` text structure:
  - cleaner tier/rate/location phrasing,
  - softer tenure phrasing,
  - clearer savings/perk language,
  - more conversational cancellation bridge.
- Updated lookup failure copy to be more human and less abrupt.

In `src/lib/system-prompt.txt`:
- Added stronger tone constraints:
  - empathy-first language,
  - conversational contractions,
  - shorter, readable account-detail delivery.

### Behavioral Impact
- Membership responses read less scripted and more natural.

### Design Decisions / Tradeoffs
- Kept deterministic data structure while softening language.
- Tradeoff: tighter copy templates reduce stylistic spontaneity but improve consistency.

---

## 4.6 `39855f7` — Remove cancellation phrase from opening chat message

### Problem Addressed
Opening message explicitly mentioning cancellation created premature churn framing.

### Specific Code Changes
In `src/app/api/chat/start/route.js`:
- Removed “including cancellation requests” from `OPENING_MESSAGE`.

### Behavioral Impact
- Neutral opening tone; cancellation context triggered only when user intent indicates it.

### Design Decisions / Tradeoffs
- Chose neutral framing to avoid steering users toward cancellation vocabulary.

---

## 4.7 `517ec14` — Update opening message copy and include time-sensitive help line

### Problem Addressed
Needed explicit urgent-help and booking guidance in opening copy.

### Specific Code Changes
In `src/app/api/chat/start/route.js`:
- Updated `OPENING_MESSAGE` to include:
  - “For time sensitive help, call (888) 677-0055.”
  - booking CTA via silvermirror.com.

### Behavioral Impact
- Users get immediate urgent/support routing from first message.

### Design Decisions / Tradeoffs
- Chose explicit operational guidance in greeting to reduce misrouted urgency.

---

## 4.8 `18daccd` — Fix sheet formatting and incomplete-session outcome defaults

### Problem Addressed
- Incomplete sessions defaulted to `REFERRED` instead of `INCOMPLETE`.
- Output formatting issues in email/sheets: `$$`, `$null`, literal `null` strings.

### Specific Code Changes
In `src/app/api/chat/end/route.js`:
- Fallback summary outcome changed from `REFERRED` to `INCOMPLETE`.
- `sheet_solution` updated to explicit incomplete-session follow-up language.

In `src/lib/notify.js`:
- Added value sanitizers:
  - `isNilLike(...)`
  - `toSheetValue(...)`
  - `toCurrencyCell(...)`
- Updated email body/HTML to use normalized currency/null-safe formatting.
- Updated cancellation sheet row mapping (A:V) to sanitize every field and apply clean currency formatting.

### Behavioral Impact
- Correct outcome semantics for short/incomplete sessions.
- Cleaned downstream reporting and removed formatting artifacts.

### Design Decisions / Tradeoffs
- Normalized values centrally in notifier layer to avoid duplicating guards across routes.

---

## 4.9 `c29e63d` — Harden end-session recovery with client membership context

### Problem Addressed
Cold-start/session-loss scenarios still caused `/api/chat/end` to miss membership context and skip expected logging.

### Specific Code Changes
In `src/app/api/chat/end/route.js`:
- Added numeric-safe helper: `toFiniteNumberOrNull(...)`.
- Recovery now reconstructs `memberProfile` from client `summary` when needed.
- Existing sessions now also accept `memberProfile`/`summary` hints from request body to avoid false `GENERAL` closure.

In `src/app/api/chat/message/route.js`:
- Included `memberProfile` in successful response payloads.

In `src/app/widget/page.js`:
- Added `memberProfile` state.
- Stores profile when returned from message API.
- Sends `memberProfile` with `/api/chat/end` requests (both auto-end and manual end).

### Behavioral Impact
- Incomplete/short sessions with recovered context now write proper rows more reliably.
- Reduced “session not found -> no row” failure mode.

### Design Decisions / Tradeoffs
- Chose to trust client-provided recovered context to improve resilience in serverless rotation.
- Tradeoff: context integrity depends on client payload quality.

---

## 4.10 `08f85c6` — Shorten opening chat greeting copy

### Problem Addressed
Opening message was still too long for first impression.

### Specific Code Changes
In `src/app/api/chat/start/route.js`:
- Reduced greeting to concise two-line intro:
  - assistant capability line,
  - “How can I help today?”

### Behavioral Impact
- Faster, cleaner conversation start.

### Design Decisions / Tradeoffs
- Moved some operational guidance out of greeting to reduce initial cognitive load.

---

## 4.11 `99dc49e` — Add discount-aware savings metrics from Boulevard profile data

### Problem Addressed
Savings messaging was too limited (rate-lock/walk-in only) and missed member discount economics.

### Specific Code Changes
In `src/lib/boulevard.js`:
- Added `clientFieldCache` + `CLIENT_FIELD_CACHE_TTL_MS`.
- Added introspection helpers and adaptive field selection:
  - `getClientTypeFieldSet(...)`
  - `fetchClientCommerceMetrics(...)`
- Extended profile fields with discount totals:
  - `totalDiscounts`, `totalServiceDiscounts`, `totalRetailDiscounts`, `totalAddonDiscounts`.
- Added math helpers: `roundCurrency`, `readFirstFinite`, `sumPositive`.
- Expanded `computeValues(...)`:
  - aggregate discount savings,
  - confidence labeling (`high` vs `estimated`).
- Updated prompt profile injection in `formatProfileForPrompt(...)` to expose new computed savings signals.

In `src/app/api/chat/message/route.js`:
- Updated post-lookup greeting to prefer member-discount savings when available.

In `src/lib/system-prompt.txt`:
- Added computed-value guidance for member discount savings + estimate labeling.

### Behavioral Impact
- Bot can discuss service/product/add-on savings more realistically when data exists.

### Design Decisions / Tradeoffs
- Used schema introspection because Boulevard client fields vary across environments.
- Tradeoff: additional API calls/complexity for richer savings context.

---

## 4.12 `8a3d323` — Exclude first-time promo discounts from member savings totals

### Problem Addressed
Total discount fields could include first-time promo, inflating ongoing member-savings narrative.

### Specific Code Changes
In `src/lib/boulevard.js`:
- Added first-time promo field mapping (`firstTimePromoDiscounts` and aliases).
- In `computeValues(...)`:
  - subtracts first-time promo from explicit total discounts,
  - floors at zero,
  - surfaces `excludedFirstTimePromoDiscounts`.
- Added exclusion visibility line in `formatProfileForPrompt(...)`.

In `src/lib/system-prompt.txt`:
- Added rule that first-time promo discounts should be excluded when available.

### Behavioral Impact
- Reduced overstatement risk in member discount total messaging.

### Design Decisions / Tradeoffs
- Conservative bias: better to understate than overstate financial value.
- Tradeoff: depends on Boulevard exposing promo fields.

---

## 4.13 `9a2c69a` — Add simple 20% savings fallback and promo exclusion handling

### Problem Addressed
Some profiles still lacked explicit discount totals and detailed components, leaving no savings value to present.

### Specific Code Changes
In `src/lib/boulevard.js`:
- Added fallback logic in `computeValues(...)`:
  - `detailedEstimateTotal` from component discounts,
  - `simpleSpendBasis` from dues + known spend,
  - `simpleTwentyPctSavingsEstimate` when only coarse spend exists.
- Added confidence state `estimated_simple_20pct`.
- Added prompt profile line for 20% estimate.

In `src/app/api/chat/message/route.js`:
- Added estimate suffix variants:
  - high confidence: no suffix,
  - detailed estimate: `(estimated)`,
  - simple spend estimate: `(estimated from total spend)`.

In `src/lib/system-prompt.txt`:
- Added explicit guidance for “20% of known spend” fallback framing.

### Behavioral Impact
- Fewer “no savings available” responses when data is sparse.

### Design Decisions / Tradeoffs
- Deliberately labeled fallback as estimated to preserve trust.
- Tradeoff: approximation can deviate from exact historical discount behavior.

---

## 4.14 `5d29c5c` — Add savings harness and humanize membership tone transitions

### Problem Addressed
Savings logic lacked deterministic regression tests; tone still risked repetitive opener patterns.

### Specific Code Changes
New testing assets:
- `scripts/savings-harness.mjs`:
  - fixture-driven assertions against `computeValues()`.
- `__tests__/fixtures/savings-golden-set.json`:
  - 8 canonical scenarios.
- `docs/SAVINGS_HARNESS.md`:
  - runbook and extension guide.
- `package.json`:
  - added `test:savings` script.

In `src/app/api/chat/message/route.js`:
- Added deterministic variant engine:
  - `hashText(...)`, `pickVariant(...)`.
- Added sensitive-context detection.
- Humanized post-lookup and lookup-failure phrasing using seeded variants.
- Added calmer “sensitive cancellation” bridges.

In `src/lib/system-prompt.txt`:
- Added varied lookup-collection phrasing guidance and humanized transition guidance.
- Added tone adaptation rules for stressed/upset users.

### Behavioral Impact
- `computeValues()` now has repeatable, fixture-based QA coverage.
- Conversational flow is varied without random nondeterminism.

### Design Decisions / Tradeoffs
- Deterministic seeded variants chosen over randomization so QA transcripts remain reproducible.

---

## 4.15 `fb139e7` — Fix cancellation confirmation flow to manager handoff + 48h email

### Problem Addressed
Bot was deflecting identified cancellation requests to self-serve form/email instead of confirming capture + internal handoff.

### Specific Code Changes
In `src/lib/system-prompt.txt`:
- Rewrote cancellation policy section:
  - identified members: confirm decision captured, manager/team backend handoff, 48-hour confirmation email, 30-day processing, 90-day credit validity.
  - fallback form/email only for unidentified/lookup-failed cases.
- Added hard rules:
  - ban “I can’t process this in chat” in identified membership cancellation flows,
  - ban unnecessary web-form deflection in identified flows.
- Updated capability statement to allow in-chat capture + handoff behavior for membership cancellation workflows.

### Behavioral Impact
- Cancellation close aligns with desired service model and reduces friction.

### Design Decisions / Tradeoffs
- Prompt-level enforcement was fastest path to broad behavioral correction without adding brittle route-specific hardcoding.

---

## 4.16 `20f7196` — Add booking incident escalation to QA email and support sheet

### Problem Addressed
Booking/payment friction reports were not reliably escalated/logged as operational incidents.

### Specific Code Changes
In `.env.example`:
- Added incident config docs:
  - `GOOGLE_SUPPORT_INCIDENT_SHEET_ID`
  - `EMAIL_QA_ALERT`

In `src/app/api/chat/message/route.js`:
- Added incident detection pipeline:
  - `BOOKING_CONTEXT_KEYWORDS`
  - `ISSUE_CONTEXT_KEYWORDS`
  - `isBookingPaymentIncident(...)` requiring both.
- Added contact extraction helpers:
  - `extractName`, `extractEmail`, `extractPhone`, `extractLocation`.
- Added fast-path before Claude for non-membership context:
  - logs incident via notifier,
  - returns deterministic support response with 48-hour SLA + phone guidance.

In `src/lib/notify.js`:
- Added support incident channels:
  - `sendSupportIncidentEmail(...)`
  - `logSupportIncidentToGoogleSheets(...)`
  - `logSupportIncident(...)` using `Promise.allSettled`.

In `src/lib/system-prompt.txt`:
- Added booking/payment issue handling guidance and no-emoji reinforcement.

### Behavioral Impact
- Booking/payment failures are now operationally visible with auditable incident records.

### Design Decisions / Tradeoffs
- Fast-path implemented before Claude call to avoid model variance and ensure incident logging always runs.
- Tradeoff: regex detection requires iterative tuning.

---

## 4.17 `c4b5f64` — Expand issue regex to match verb conjugations

### Problem Addressed
Incident fast-path failed on real phrasing like “calendar freezes…”, so incidents routed to Claude fallback and were not consistently logged as incidents.

### Specific Code Changes
In `src/app/api/chat/message/route.js`:
- Expanded `ISSUE_CONTEXT_KEYWORDS` to include conjugations/plurals:
  - `fail(s|ing)`, `freezes/freezing`, `crashes/crashing`, `glitches/glitching`, etc.

### Behavioral Impact
- Booking/payment incident fast-path triggers on more realistic user wording.

### Design Decisions / Tradeoffs
- Broadened regex while retaining booking-context requirement to limit false positives.

---

## 4.18 `1da0472` — Auto-apply support sheet headers and formatting for website bugs

### Problem Addressed
Support incident sheet could drift (missing headers, poor readability, inconsistent status field quality).

### Specific Code Changes
In `src/lib/notify.js`:
- Replaced simple tab-title lookup with `getFirstSheetMeta(...)` including `sheetId`.
- Added `ensureSupportIncidentSheetLayout(...)`:
  - writes headers if missing,
  - preserves existing first-row data by inserting a row,
  - freezes header row,
  - applies header styles,
  - sets filter,
  - standardizes column widths,
  - enables wrap/top alignment,
  - enforces status dropdown validation (`Open`, `In Progress`, `Resolved`).
- `logSupportIncidentToGoogleSheets(...)` now calls layout enforcement before append.

### Behavioral Impact
- Incident sheet is self-healing and standardized across environments.

### Design Decisions / Tradeoffs
- Chose auto-format in code to remove manual Ops setup dependency.
- Tradeoff: extra Sheets API calls per incident append.

---

## 4.19 `f8894bb` — Fix cancellation intent carryover, inactive flow, and pause credits FAQ

### Problem Addressed
QA found three conversational defects:
- cancellation intent dropped after lookup,
- inactive-account path gave confusing retention prompts,
- pause-credit FAQ deflected instead of answering directly.

### Specific Code Changes
In `src/app/api/chat/message/route.js`:
- Added context helpers:
  - `collectRecentUserText(...)`
  - `hasCancellationIntent(...)`
  - `isInactiveAccountStatus(...)`
- Updated `buildPostLookupGreeting(...)`:
  - consumes combined recent+current user text to preserve cancellation intent through lookup boundaries,
  - branches inactive account flow early with status confirmation + backend follow-up language.
- Added direct FAQ fast-path for pause/credit questions:
  - `PAUSE_CREDIT_KEYWORDS`, `PAUSE_HOLD_KEYWORDS`
  - `isPauseCreditsQuestion(...)`
  - `buildPauseCreditsAnswer(...)`
- Added `stripEndFollowUpQuestions(...)` and applied it when a membership summary closes chat to remove trailing “anything else?” phrasing.

In `src/lib/system-prompt.txt`:
- Added corresponding hard rules:
  - inactive/canceled accounts skip retention questioning,
  - pause-credit direct answer policy,
  - no “anything else” at resolved close.

### Behavioral Impact
- Post-lookup flow stays on cancellation track when user started with cancellation intent.
- Inactive-account handling becomes less contradictory.
- Common pause-credit question gets immediate policy answer.

### Design Decisions / Tradeoffs
- Added deterministic route-level overrides for these high-frequency QA failures instead of relying only on prompt compliance.

---

## 5. Known Bugs / Tech Debt (As of `f8894bb`)

1. Session storage is still in-memory.
- Risk: cross-instance/serverless rotation can still lose state beyond client recovery scope.
- Mitigation present: history/summary/memberProfile recovery path exists, but not equivalent to durable storage.

2. Phone lookup remains scan-heavy at scale.
- Current fix favors reliability but can be latency-heavy for large datasets.
- Tunables exist (`BOULEVARD_PHONE_SCAN_PAGE_SIZE`, `BOULEVARD_PHONE_SCAN_MAX_PAGES`), but no adaptive/cached phone index yet.

3. Support incident logging has no retry/backoff queue.
- `Promise.allSettled` prevents blocking, but transient SMTP/Sheets failures are not retried.

4. Automated tests are still sparse outside savings.
- New savings harness exists, but end-to-end route behavior still depends on manual QA.

5. Prompt-driven behavior still carries drift risk.
- Some critical policies (especially close wording and decision-tree nuances) were prompt-only at this point.

---

## 6. Boulevard API Quirks Discovered in This Window

1. Phone query path was schema-sensitive and unreliable.
- `clients(query: $query)` looked attractive for speed, but generated GraphQL argument errors in production runtime for this project’s endpoint/schema behavior.
- Outcome: direct path removed; scan path standardized (`ee8b00b`).

2. Large-list phone matching requires pagination tuning.
- Reliable phone lookup required scanning many pages for some accounts.
- Exposed env tunables to adjust depth without code edits.

3. Client field availability is not uniform.
- Discount/savings fields differed across environments.
- Added Client type introspection + cache and conditional query construction (`99dc49e`).

4. Membership resolution needed heuristic selection.
- Multiple membership records/statuses required selection strategy (active > paused > pending > canceled + recency/term tie-breakers already in code path from prior window).

5. GraphQL errors had to be selectively muted.
- Optional enrichment queries use `silentErrors` to avoid noisy logs while preserving base lookup path.

---

## 7. Things That Almost Broke (Tried, Reverted, or Edge-Case Corrected)

1. Direct phone fast-path experiment (`1257134`) was reverted in `ee8b00b`.
- Intended optimization caused production lookup misses due GraphQL argument errors.

2. Incident fast-path initially missed natural wording.
- Regex failed to catch verb forms like “freezes” due boundary/conjugation mismatch.
- Corrected in `c4b5f64`.

3. End-session reporting initially mislabeled incomplete sessions as `REFERRED`.
- Fixed in `18daccd` to `INCOMPLETE`.

4. Sheet/email output formatting created noisy artifacts (`$$`, `$null`, literal `null`).
- Fixed via centralized sanitization/currency formatting in `18daccd`.

5. Cold-start end-route lost membership context in short sessions.
- Fixed by forwarding `memberProfile` and reconstructing from summary when needed (`c29e63d`).

6. Opening greeting copy churned across three commits.
- Iterated quickly based on live QA/operator preference (`39855f7`, `517ec14`, `08f85c6`).

---

## 8. Correct Boulevard API URL + Auth Flow (What Works vs What Failed)

## 8.1 Working configuration

Endpoint:
- `https://dashboard.boulevard.io/api/2020-01/admin`
- Business-scoped variant also valid:
  - `https://dashboard.boulevard.io/api/2020-01/<BUSINESS_ID>/admin`

Required env vars:
- `BOULEVARD_API_URL`
- `BOULEVARD_API_KEY`
- `BOULEVARD_API_SECRET` (base64 secret)
- `BOULEVARD_BUSINESS_ID`

Auth flow implemented in code (`src/lib/boulevard.js`):
1. Build payload: `blvd-admin-v1${businessId}${timestamp}`
2. Decode secret from base64
3. HMAC-SHA256(payload, decoded secret) -> base64 signature
4. Build token: `${signature}${payload}`
5. Build Basic credential: base64(`${apiKey}:${token}`)
6. Send request headers:
   - `Authorization: Basic <credential>`
   - `Content-Type: application/json`
   - `X-Boulevard-Business-ID: <businessId>`

## 8.2 What was tried and why it failed

`dashboard.boulevard.app`:
- Failed with DNS resolution (`ENOTFOUND`), domain is not the working Admin API host for this integration.

`.../admin.json`:
- This path caused inconsistent/failing behavior during this project’s troubleshooting cycle.
- Code now normalizes URLs to `/admin` by stripping `.json` to avoid endpoint mismatch drift.

Direct GraphQL phone query path (`clients(query: $query)`):
- Produced runtime GraphQL argument errors in this environment for phone lookup.
- Removed in favor of paginated scan path in `ee8b00b`.

---

## 9. Validation Notes for This Window

Evidence-backed checks performed during this development window included:
- Build checks on updated code paths.
- Savings harness added and used to verify `computeValues()` regression behavior.
- Live QA rounds validating:
  - phone lookup behavior,
  - cancellation close behavior,
  - end-session row writing,
  - support incident logging path.

---

## 10. Out-of-Scope Note

This document intentionally ends at `f8894bb` to match requested range.
Subsequent commits (for example, `add0b1d`) are not included here.
