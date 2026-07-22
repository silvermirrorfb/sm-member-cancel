# QA_ISSUES.md - sm-member-cancel

**Purpose:** Canonical, living ledger of every known production issue across the cancel bot and outbound SMS systems in this repo. Read this before opening any PR. Update this when shipping a fix or surfacing a new issue.

**Last updated:** July 22, 2026 (outbound-sms #15, #16, #17 fixed in code on branch `fix/carveout-followup-hardening`, awaiting Matt's merge; Klaviyo transactional carve-out for the applied follow-up ratified in CLAUDE.md and docs/outbound-sms-system-and-issues.md. Prior update May 28, 2026: Phase 1-10 decision-audit branch + P2 code-level follow-up branch. Decision-audit branch `fix/cancel-bot-decision-audit-2026-05-27` shipped cancel-bot #25-29 plus lock-in regressions and the Decision 7 open-conflict surface. Stacked follow-up branch `fix/cancel-bot-code-level-sla-and-perk-enforcement` shipped cancel-bot #30 server-side SLA strings stripped + cancel-bot #31 runtime perk-value injection stripped. Both branches awaiting Matt's ship word; second branch depends on the first merging first.)
**Maintainer:** Matt Maroone, with AI agent updates on every PR merge
**Source docs:** `docs/outbound-sms-system-and-issues.md`, `docs/cancel-bot-system-and-issues.md`

---

## How to read this file

Each issue has:

- **System:** outbound-sms or cancel-bot or cross-cutting
- **Severity:** prod-down, customer-harm, compliance-risk, trust-erosion, ux, dev-friction
- **Status:** OPEN, IN PROGRESS, AWAITING DECISION, VERIFIED FIXED, NOT FIXED
- **PR reference** when applicable
- **One-paragraph plain-English description** of what broke and why

Issues are numbered per system, in chronological order of discovery. Numbers do not get reused.

---

## Currently open at the top of the list

What's actually still open right now, in order of stakes:

**Member-harm incident on record:**

- **outbound-sms #11** - Real member (Maureen Golga, 2026-05-20) lost a booked appointment to the destructive cancel-rebook fallback. Production is already guarded by the `NODE_ENV !== 'production'` check; PR A removes the duration-upgrade fallback code outright, PR B the add-on fallback, PR C the now-unused env var.

**Production escalations from Fernanda (May 6-10), shipping May 13 in corrected order:**

1. **cancel-bot #20 (and code half of cancel-bot #6)** - FIXED IN CODE 2026-05-13 by PR `fix/broaden-no-process-handoff-rule` (PR 1 of the May 13 sequence, not yet merged). Three edits to `src/lib/system-prompt.txt`: (a) new `HARD RULE - MILESTONE DISCUSSION SCOPE` (upcoming only, no historical-perk enumeration like Zoe got); (b) new `HARD RULE - NO DEFINED PROCESS HANDOFFS` mandating Travis's exact phrase "I'm flagging this for our memberships team to review. Someone will follow up with you about next steps." with bans on specific timelines, outcomes, and actions; (c) strengthened PR #13's `HARD RULE - NO FABRICATED ESCALATION` with Sindhura-class soft-promise example bans ("they'll resolve this," "they'll reach out within 24-48 hours," etc.). 18 new tests cover both production cases plus PR #5/#6/#13 preservation. Bump to VERIFIED FIXED after merge + production deploy.
2. **cancel-bot #19 part 1** - Sindhura Polepalli (May 10) REFERRED + Technical Issue routed to `42-generic-cancelled`; her session predates PR #8 merge May 12. PR 4 reads the Cancellations Google Sheet to confirm REFERRED sessions on or after 2026-05-13 route to `43-referred-manual-review` (not `42-generic-cancelled` or any other template). Verification only, no code change unless a regression is surfaced.
3. **cancel-bot #18** - Rose Williamson (May 6): RETAINED + Travel + accepted Bi-monthly routed to `01-travel-pause` instead of a bi-monthly confirmation. Fernanda rewrote by hand. PR 2 in `src/lib/member-draft.js`: audit every accepted-offer × reason combination, make accepted-offer the primary key for RETAINED template routing (reason-templates as fallback only when no save offer was accepted), and add a bi-monthly confirmation template if one doesn't already exist. Closes the gap PR #4 left in RETAINED routing.
4. **cancel-bot #19 part 2** - FIXED IN CODE 2026-05-15 by PR `fix/email-placeholder-string-sanitization`. Sindhura's email body contained the literal placeholder string `Your existing credits (5 (missing from display)) are usable for 90 days`. PR adds an `isPlaceholderValue` + `creditsParen` sanitization layer in `src/lib/member-draft.js` (matches "missing from display", "unknown", "TBD", empty string, and any stray parenthesis), then applies it to every `unused_credits` interpolation across 14 templates plus the special-case voucher-credit conversion template. 13 new tests cover the Sindhura regression, every credits-bearing template, and preservation of legitimate values. Bump to VERIFIED FIXED after merge + production deploy. Part 1 (REFERRED routing) was already verified fixed in PR #19.

**Ship order today:** PR 1, PR 4, PR 2, PR 3. PR 1 smallest scope and biggest surface (system prompt only). PR 4 verification only (Sheet read). PR 2 and PR 3 both touch `member-draft.js` in different functions; PR 2 first so its audit can surface fields PR 3 needs to know about.

**Still parked behind Travis decisions or provisioning calls:**

4. **cancel-bot #5** - Bot pushes retention past clear refusals. Customer harm and FTC Negative Option exposure. Decision 1 (retention aggressiveness after first clear refusal generally) FIXED IN CODE 2026-05-15 by PR `fix/retention-softening-and-credit-disclaimer` (Christina case fix: HARD RULE - FIRM REFUSAL SHORT-CIRCUIT skips final-warning loss-framing after one offer + a firm second refusal, preserves the first retention offer, defines firm vs non-firm refusal phrasings, allows one clarifying question on ambiguous responses). Decision 2 (geographic exits / out-of-footprint relocation) FIXED IN CODE 2026-05-15 by PR `fix/relocation-out-of-footprint-no-retention` (Congo case fix: HARD RULE - FOOTPRINT-AWARE RELOCATION HANDLING skips retention entirely for moves outside NYC/DC/Miami metros, preserves in-footprint transfer-first behavior, 19 new tests). Both halves now FIXED IN CODE.
5. **cancel-bot #12** - Identity verification is name + email only; the bot then processes pause/cancel/billing changes on that. Privacy and bad-actor risk. AWAITING Travis Decision 5.
6. **cancel-bot #6 (broader)** - The fabricated-escalation prompt guardrail shipped (PR #13). The generic no-SLA escalation language and the strengthened example bans resolve via cancel-bot #20 / PR 1. Whether/how to soften the "48-hour confirmation email" promise in the outcome-notification path (separate from in-chat escalation language) and the `sendBeacon` robustness for leg-A are still AWAITING Travis Decision 3.
7. **cancel-bot #11 / #15 / #17** - the rest of the Travis decisions (perk dollar values; tone; commitment language). Code is mostly trivial; the calls aren't ours. (cancel-bot #14 / credit visibility resolved 2026-05-15 by PR `fix/retention-softening-and-credit-disclaimer` per Travis Decision 7. cancel-bot #16 / channel-loop rule resolved 2026-05-15 by PR `fix/already-tried-channel-auto-escalation` per Travis Decision 9. cancel-bot #13 / refund-double-billing script resolved 2026-05-15 by PR `fix/billing-dispute-escalation-script` per Travis Decision 6.)
8. **Sentry DSN not set** - PR #12 wired `@sentry/nextjs` but it's inert until someone creates a Sentry project and runs `vercel env add SENTRY_DSN production`. Cowork task.
9. **Dedicated staging Vercel project** - the cross-cutting #5 "real gap": `dryRun` + synthetic mode + previews now cover most safe testing (see `docs/STAGING.md`), but a fully-isolated `sm-member-cancel-staging` project with its own env vars is still a provisioning decision for the Vercel-team owner (not done unilaterally - it's billable infra).

**Recently fixed (all 2026-05-12):** outbound-sms #8 (cron uses per-location appointment discovery, not random registry sampling - verified sending, PR #9); outbound-sms #9 (discovery candidates resolved by clientId, `member_not_found` eliminated - verified, PR #15); cross-cutting #1 (daily send counter + zero-send alert cron, PRs #10-11); error monitoring wired (Sentry, PR #12); cancel-bot #6 code portion (no-fabricated-escalation prompt rule, PR #13); cancel-bot #9 adjacent vuln (email-template reason regexes anchored, PR #14); cross-cutting #4 (per-subsystem env validation, loud at boot, PR #16); cross-cutting #2 (conversational eval scaffold, skip-by-default) + cross-cutting #5 partial (safe-test paths documented in `docs/STAGING.md`).

---

## Outbound SMS issues

### outbound-sms #1
**Status:** RESOLVED (architectural, not a fix)
**Severity:** required re-architecture
**Discovered:** Late April 2026, initial build

Boulevard's GraphQL API has no "appointments by location" query. Only per-client lookups. Required building the Redis-backed daily client registry as a workaround. The seed cron pages all clients per location into Redis, then the scan cron loops through clients and asks Boulevard for each one's appointments individually. Slower, but functional. Not a bug, a platform limitation.

---

### outbound-sms #2
**Status:** VERIFIED FIXED
**Severity:** prod-down (hard failure)
**Discovered:** Initial build

`BOULEVARD_API_URL` env var was set with `/graphql` already in the path, but the code was also appending `/graphql`. Every request 404'd. Fix was removing the appended `/graphql` from the code. The env var is now the source of truth.

**Do NOT touch the Boulevard API URL.** Any future "fix" that modifies it is almost certainly going to break things again.

---

### outbound-sms #3
**Status:** RESOLVED with throughput tradeoff
**Severity:** prod-down (silent cron failure)
**Discovered:** Initial build

Boulevard's `clients` API is slow. Initial seed cron tried 100 clients per page and timed out on Vercel's serverless limit. Scan cron had the same issue at large batch sizes. Reduced seed to 20 per page, scan to 5 candidates per run (was 50, then 10, then 5). Tradeoff is throughput: roughly 7.5% daily coverage of the 4,000-guest registry. Some eligible guests will not get a text on any given day, by design.

---

### outbound-sms #4
**Status:** VERIFIED FIXED
**Severity:** coverage problem
**Discovered:** Initial build

First version of scan cron always pulled first N entries from Redis. Same guests checked every run. Added Fisher-Yates shuffle so every run samples a different random subset. Does not increase coverage but spreads checks evenly over time.

---

### outbound-sms #5
**Status:** VERIFIED FIXED
**Severity:** wasted API calls, no send harm
**Discovered:** Pre-outage diagnostic, late April 2026

Klaviyo compound segment `S3NdQB` was being used as the SMS-subscribed filter. Sampling showed 10 of 10 segment members were actually `NEVER_SUBSCRIBED`. Segment was unreliable. Switched to per-profile subscription status check at send time. Slower but accurate. Legal compliance gate is now bulletproof.

**Rule for future work:** Per-profile checks only. Never trust a Klaviyo segment as the consent gate.

---

### outbound-sms #6
**Status:** VERIFIED FIXED in code, VERIFICATION OF EFFECT IN PROGRESS (see Issue 8)
**Severity:** prod-down (catastrophic, 3-week zero-sends outage)
**Discovered:** May 5, 2026 (Matt manually noticed empty SMS log)
**Resolution:** PR #3 merged May 5

In `src/lib/boulevard.js`, the appointment-query field selector used a one-or-the-other pattern between the `clientId` scalar and the `client` object:

```javascript
if (clientIdField) selectedFields.push(clientIdField);
else if (clientObjectField) {
  selectedFields.push(`${clientObjectField} { id firstName lastName email phone ... }`);
}
```

Boulevard's appointment type has BOTH. Introspection picked `clientId` first, the `else` branch was never taken, so every appointment came back with `clientFirstName`, `clientEmail`, `clientPhone` all null. Downstream code filtered those out as "incomplete data." Candidate pool was always empty for 3 weeks.

Fix is one word: change `else if` to `if`. Additive selection, both fields. Cursor ran a live Boulevard query to confirm `client.firstName` populates when both are requested.

**Process gap surfaced:** No alerting on zero sends. Outage went undetected for 3 weeks. Still not built. See cross-cutting section.

---

### outbound-sms #7
**Status:** REJECTED (caught before commit)
**Severity:** would have been bad if shipped
**Discovered:** May 5, 2026, immediately after PR #3

Claude Code (parallel session) produced a 5-change bundle as a single commit immediately after PR #3:

1. Rewrite scan cron to appointment-scanning instead of registry-random
2. Add skip-reason histogram to cron response
3. Add deterministic addon rotation by phone hash
4. Replace in-memory Map cooldown with Redis-backed async cooldown
5. Add member tier resolution via registry fallback

Some of these (#2 telemetry, #5 tier resolution) are good ideas as standalone PRs. The cron rewrite (#1) would have destroyed the clean verification signal for PR #3. Bundle was stashed in the archive clone (`Code\silvermirrorfb\sm-member-cancel`), never committed.

**Rule for future work:** Each idea can be revisited individually, in its own PR, AFTER PR #3 verification is closed out. No bundles, ever.

---

### outbound-sms #8
**Status:** VERIFIED FIXED 2026-05-12 (PR #9 `fix/sms-cron-uses-appointment-discovery`, merged to main `34eb5ec`)
**Severity:** was prod-down (near-zero sends)
**Discovered:** May 5, 2026 (verification never closed) - root cause nailed down 2026-05-12

**Verification (2026-05-12, post-deploy):** triggered the cron once via `CRON_SECRET` and got `{ candidateCount: 23, summary: { total: 23, sent: 2, skipped: 21, errors: 0, skippedByReason: { klaviyo_sms_not_subscribed: 9, addon_already_on_booking: 4, no_appointments_available: 4, no_upcoming_appointment_in_window: 3, no_upgrade_target_for_duration: 1 } } }` - two real texts sent (Martha Horan: addon offer; Stephanie Li Sullivan: duration-upgrade offer), zero errors, all skips legitimate business logic. Redis confirmed: 2 new `sms-cooldown:{phone}:{appointmentId}` keys matching the 2 sends. Outbound SMS upgrade texts are sending in production again. (Funnel note: ~39% of discovered candidates filtered at the Klaviyo SMS-consent gate - that is the TCPA gate working, expected, not a bug.)

**Real root cause (the 2026-05-12 investigation):** the practical cause of the near-zero sends was NOT the PR #3 client-fields bug. PR #3 (`631a0e1`) fixed `scanAppointments`'s client-field selection, but that bug only affected the `locations[]` discovery path in `/api/sms/automation/pre-appointment`. The `sms-upgrade-scan` cron does not use that path - it was switched to random-registry-sampling in commit `3606088` (2026-04-08). Random-sampling 30 of ~6,394 registry members per run means almost no sampled member has an appointment in the next 24h, so `evaluateUpgradeOpportunityForProfile` returns `no_appointments_available` for nearly all of them (probed 6 random members 2026-05-12: all 6 returned that). Config gates were all open the whole time (`SMS_CRON_ENABLED=true`, `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=false`, `SMS_UPGRADE_STATUS=live`, all 10 locations). The Redis registry is healthy (~6,394 members, valid data). `lookupMember` works. A direct `locations[]` discovery probe (Bryant Park, 24h, dryRun) returned 22 appointments with populated client fields (so PR #3 IS working) and 1 would-send addon offer (so the pipeline works end-to-end) - funnel: 8 `member_not_found`, 4 `klaviyo_sms_not_subscribed`, 3 `addon_already_on_booking`, 3 `no_upcoming_appointment_in_window`, 3 `appointment_scan_failed`, 1 would-send.

**The fix:** `src/app/api/cron/sms-upgrade-scan/route.js` now builds candidates by scanning appointments per location (`scanAppointments({ locationId, windowStart, windowEnd })`) for a rotating subset of the target locations each run, mirroring pre-appointment's discovery filter (drop appointments missing name/email/phone), deduping by client, capping at `SMS_CRON_MAX_CANDIDATES` (default 40), then feeding them through the existing parallel-batch-of-5 sender. Knobs: `SMS_CRON_DISCOVERY_WINDOW_HOURS` (default 24), `SMS_CRON_LOCATIONS_PER_RUN` (default 2 - every location covered roughly every ~50 min), `SMS_CRON_MAX_CANDIDATES` (default 40). Also added `summary.skippedByReason` and a `console.log('[sms-upgrade-scan]', ...)` so the run shows up in Vercel logs. Test: `__tests__/sms-upgrade-scan-route.test.js`.

Spin-off: the `member_not_found` rate observed in the funnel (~36%) got its own issue once Cowork confirmed it persisted. See outbound-sms #9.

---

### outbound-sms #9
**Status:** VERIFIED FIXED 2026-05-12 (PR #15 `fix/sms-resolve-candidate-by-clientId`, merged to main `fc74d9c`)
**Severity:** lost outbound volume + misleading skip reasons
**Discovered:** 2026-05-12 (Cowork dig into the funnel from #8)

**Verification (2026-05-12, post-deploy cron trigger):** `{ candidateCount: 15, summary: { total: 15, sent: 3, skipped: 12, errors: 0, skippedByReason: { klaviyo_sms_not_subscribed: 4, no_appointments_available: 4, no_upcoming_appointment_in_window: 1, addon_already_on_booking: 1, no_upgrade_target_for_duration: 2 } } }`. `member_not_found` is gone from the skip reasons (was 3 of 23 in the pre-fix probe), the genuinely-opted-out folks now correctly read `klaviyo_sms_not_subscribed`, and 3 real texts went out with 0 errors. So Boulevard's `client(id:)` query IS supported and the by-id resolution works.

About a third of the appointment-holders the discovery scan turns into candidates come back `member_not_found` and get dropped before the Klaviyo gate or eligibility check run. Cowork looked up four of them in Boulevard + Klaviyo: each has a real client record, but their appointments aren't attached to the record you find by name/email (Boulevard has duplicate/fragmented client records; the appointment's `clientId` points at a different duplicate). Three of the four are also genuinely `NEVER_SUBSCRIBED` for SMS in Klaviyo, so even if `lookupMember` had found them they'd be skipped at the consent gate; the fourth (Rachel Martell) IS SMS-subscribed but her appointment is at a different location than the scan slice was covering (rotation, not a bug).

Root cause: discovery candidates already carry a verified `clientId` from the scanned appointment, but `/api/sms/automation/pre-appointment` threw it away and re-ran `lookupMember(name, email)` (a fuzzy name+email lookup that misses on duplicates / email mismatches).

**Fix:** added `getClientById(clientId)` to `src/lib/boulevard.js` (`client(id: $id)` query, `silentErrors`, returns null on any failure or id-mismatch, inert for non-`urn:blvd:Client:` ids). `/api/sms/automation/pre-appointment` now resolves a candidate by `clientId` first and only falls back to `lookupMember` when there's no clientId or the direct fetch comes up empty. Net effect: the genuinely-opted-out candidates now correctly read `klaviyo_sms_not_subscribed` instead of `member_not_found`, and anyone genuinely eligible who was being dropped by a flaky name match now gets their text. No regression risk: if the `client(id:)` query is unsupported or fails, every call falls back to today's behavior. Tests: `__tests__/sms-automation-route.test.js` (resolves-by-clientId; falls-back-when-null).

**Verify post-deploy:** watch the `[sms-upgrade-scan]` log lines for a few in-window runs - `summary.skippedByReason.member_not_found` should drop sharply (mostly migrating into `klaviyo_sms_not_subscribed`), and `summary.sent` should tick up slightly. If `member_not_found` doesn't move at all, the `client(id:)` query may be unsupported and every call is silently falling back - then we'd need to try `clients(first:1, ids: [$id])` instead. Once confirmed, change status to VERIFIED FIXED.

---

### outbound-sms #10
**Status:** VERIFIED FIXED 2026-05-18 (PR #30 `fix/sms-cron-transport-vercel-protection`, merged to main `d5c04fe`)
**Severity:** total outage (zero outbound SMS sends for 5 days)
**Discovered:** 2026-05-17 (daily zero-send health-check email fired after the May 12 success counter's 3-day Redis TTL expired)

**Symptom:** Zero outbound SMS sends from `/api/cron/sms-upgrade-scan` from 2026-05-12 through 2026-05-17. Cron summary log showed `summary: {sent:0, errors:0, skippedByReason: {unknown: N}}` on every run that found candidates. No `sms-sent:YYYY-MM-DD` keys in Redis (TTL 3 days), no `[sms-metrics]` warnings, no `Pre-appointment automation error` logs, and the daily health-check `EMAIL_ESCALATION` alert email finally fired today.

**Root cause:** The cron at `src/app/api/cron/sms-upgrade-scan/route.js:205` built its self-fetch endpoint using `new URL('/api/sms/automation/pre-appointment', request.url)`. For a Vercel-triggered cron, `request.url` resolves to the deployment-specific hostname `sm-member-cancel-<hash>-silver-mirror-projects.vercel.app`, which has Vercel Deployment Protection (SSO) enabled. Every self-fetch returned HTTP 401 with an HTML SSO challenge page (~14KB) before the function ran. The cron's response handler (`checkOneCandidate` at lines 113-145) called `res.json().catch(() => ({}))` without checking `res.ok`, so the unparseable HTML body became `{}`, `payload?.results?.[0]` was undefined, `val.status` defaulted to `'unknown'`, and the summary builder bucketed each candidate as a skip with reason `unknown` rather than as an error.

Verified externally via curl: the deployment-specific URL and the team-scoped alias both return HTTP 401 with `_vercel_sso_nonce` cookie and `content-type: text/html`. The project alias `sm-member-cancel.vercel.app` returns HTTP 405 with `x-matched-path: /api/sms/automation/pre-appointment` header, proving the route is reachable on that hostname.

**Introduced by:** commit `73e2fce` on 2026-05-12, the per-location appointment discovery rewrite that replaced random-registry sampling with HTTP self-fetches. Before that commit, the cron used direct in-process calls and never made an HTTP request, so the protected host was never a factor.

**Fix:** route the self-fetch through `https://sm-member-cancel.vercel.app` (the project's stable public alias, not behind Deployment Protection). Implementation reads the base URL from `process.env.SMS_AUTOMATION_BASE_URL` with that hardcoded string as the fallback. Tests added in `__tests__/sms-upgrade-scan-route.test.js` cover both the env-var override path and the hardcoded fallback path.

**Verify post-deploy:** within the next 10-minute cron tick, (1) Vercel runtime logs should show fresh `POST /api/sms/automation/pre-appointment` invocations (any status code is fine, presence proves the route is now reachable), (2) `node scripts/diag-sms-daily-counts.mjs` should return a non-zero `sms-sent:YYYY-MM-DD` count for today's date in ET, and (3) the next `[sms-upgrade-scan]` summary log should show real reasons in `skippedByReason` like `klaviyo_sms_not_subscribed` or `no_appointments_available`, not `unknown`. Daily zero-send health-check email should stop firing tomorrow morning (next scheduled run at 14:00 UTC). Once verified, change status to VERIFIED FIXED.

**Verified 2026-05-18:** 68 sends in Redis `sms-sent:2026-05-18` counter, 30+ POST hits to `/api/sms/automation/pre-appointment` 200s in 22:00-23:30 UTC, 20+ `sms-cooldown:*` keys present (success-path-only writes).

The masking chain that hid this outage for 5 days is tracked separately as cross-cutting #2. See `docs/PLAN_sms-outage-fix_2026-05-17.md`.

---

### outbound-sms #11
**Status:** FIXED IN CODE 2026-06-03. Duration path PR A (#47, merged 59f2607). Add-on path PR B (this PR), removes tryApplyAddonViaCancelRebook so neither path can cancel a booking under any env or flag. Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer-harm
**Discovered:** 2026-05-20 (member-reported lost booking)

**Symptom:** On 2026-05-20 a real member (Maureen Golga) had a booked appointment destroyed by the outbound-SMS upgrade flow. The flow cancelled the existing appointment and then failed to create the replacement, leaving the member with no appointment and the freed slot available to others. There was no transaction wrapping the two steps and no rollback.

**Root cause:** The add-on and duration apply flows each carried a destructive cancel-then-rebook fallback (`tryApplyAddonViaCancelRebook`, `tryApplyUpgradeViaCancelRebook` in `src/lib/boulevard.js`). When the safe in-place apply failed and the fallback was enabled, the code ran `cancelAppointment` first and then attempted `bookingCreate`; any failure after the cancel left the booking permanently gone with no recovery path.

**Mitigation already in place:** `ENABLE_CANCEL_REBOOK_FALLBACK` is gated `process.env.NODE_ENV !== 'production'` (`boulevard.js:27-30`), so the destructive fallback cannot run in production today. That neutralizes the live risk but leaves the destructive code reachable in non-production and one edit away from re-exposure.

**Fix (PR A, this entry):** Remove the duration-upgrade cancel-rebook fallback entirely (`tryApplyUpgradeViaCancelRebook` and its single caller in `reverifyAndApplyUpgradeForProfile`). A duration upgrade can now only apply via the safe in-place `updateAppointment` mutation; on any failure it fails closed (`upgrade_mutation_failed`), which the webhook routes to a queued support incident plus the approved finalize-by-team SMS reply, leaving the appointment untouched. Regression test: `__tests__/boulevard-duration-upgrade-append-safety.test.js` (static-source guard plus a behavioral guard that runs with the fallback flag on in non-production and asserts no cancel). The add-on path fallback removal is PR B; removing the now-unused env var is PR C. PR B removes the add-on cancel-rebook (`tryApplyAddonViaCancelRebook`) the same way, so both the duration and add-on apply paths now fail closed with no reachable cancel.

**Verify post-deploy:** confirm `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` is off in production (`vercel env ls production --scope silver-mirror-projects`), and confirm a forced in-place failure routes a duration YES to a support incident and the finalize reply with the original appointment intact.

---

### outbound-sms #12
**Status:** FIXED IN CODE 2026-06-18 by PR `fix/sms-offer-copy-untruncated`. Bump to VERIFIED FIXED after merge + production deploy + live canary.
**Severity:** trust-erosion (also lost revenue: silently removed the upsell call-to-action for named guests)
**Discovered:** 2026-06-18 (owner-reported: received an offer that was a bare statement with no way to respond)

**Symptom:** Members received the duration-upgrade offer as a statement with no ask, e.g. "Hi Matt, good news - there's room to extend your facial today to 50 minutes for just $50 more." with the "Reply YES..." sentence missing. Members with no/short first names sometimes saw the full ask, so it looked intermittent.

**Root cause:** The send path runs the offer through `trimSmsBodyShort` (`src/lib/twilio.js`), a self-imposed 150-char short-SMS limiter that, when over the cap, keeps only the first complete sentence. The approved copy plus a personalized "Hi {firstName}," greeting was 151+ chars for most names (151 for "Matt"), so the trimmer dropped the entire final sentence (the YES/NO ask). Live since the limiter landed on 2026-03-29 (commit 8f41a13); the offer send has piped through `trimSmsBodyShort` since 2026-03-21 (6bc2669). The existing route test mocked `trimSmsBodyShort` to a pass-through, so it never caught the truncation.

**Fix (this PR):** Shortened the initial duration-offer copy to a single-segment message that keeps a real question and the YES/NO ask: "Hi {firstName}, good news: we can extend today's facial to 50 minutes for ${delta} more. Want to add it? Reply YES or NO." (109-116 chars across realistic names, well under the cap). Changed the route test to use the REAL `trimSmsBodyShort` and added a regression test (`__tests__/sms-automation-route.test.js`) asserting the built offer survives the real send-time trimmer with its ask intact. Copy wording approved by Matt 2026-06-18.

**Verify post-deploy:** trigger a dry-run offer for a named guest in production and confirm the sent body ends with "Reply YES or NO." (not "$X more.").

---

### outbound-sms #13
**Status:** BUILT 2026-06-18 by PR `fix/sms-duration-upgrade-apply-booking-flow`, **gated default-OFF** behind `BOULEVARD_ENABLE_BOOKING_UPGRADE`. NOT yet active in production. Activation is owner-gated on the non-destructive real-appointment dry-run (see below). RCA: `~/sm-rca-apply-path-2026-06-15.md`; plan: `docs/superpowers/plans/2026-06-15-sms-duration-upgrade-apply-rebuild.md`.
**Severity:** trust-erosion (the system tells members an upgrade is handled when the booking is never changed)
**Discovered:** documented 2026-06-15 (failure mode noted as far back as 2026-03-11)

**Symptom:** A YES to a duration upgrade never actually lengthens the booking in Boulevard. 100% of YES since 2026-06-04 fell to the "our team will confirm" manual fallback; the booking stays at 30 minutes.

**Root cause:** `tryApplyAppointmentUpgradeMutation` sends `updateAppointment(input:{id, serviceId})`, but Boulevard's `UpdateAppointmentInput` has no `serviceId` field (and `appointmentUpdate` does not exist). Both candidates fail GraphQL validation; `silentErrors: true` swallows the rejection; the call returns `upgrade_mutation_failed` and the webhook replies with the manual-confirm copy. Changing a booked service requires Boulevard's booking-edit flow.

**Build (this PR):** New `applyDurationUpgradeViaBooking` (`src/lib/boulevard.js`) does the non-destructive swap: `bookingCreateFromAppointment` (draft over the existing appointment) -> `bookingAddService` (50-min) BEFORE `bookingRemoveService` (30-min, so the booking is never empty) -> `bookingServiceSetPrice` to the quoted total (owner decision 2026-06-18: always honor the quoted price; cents) -> `bookingComplete(notifyClient:false)` back to the SAME appointment id -> existing read-back `verifyAppointmentServiceApplied`. Every step targets the draft `bookingId`; the live appointment changes only at commit; any step error or blocking warning aborts BEFORE commit (draft abandoned). The new path captures Boulevard error/warnings into the reverify result (no silent swallow). Wired into `reverifyAndApplyUpgradeForProfile`'s duration branch behind `BOULEVARD_ENABLE_BOOKING_UPGRADE`; when OFF (prod today) the legacy path runs unchanged (manual fallback). Tests: `__tests__/boulevard-duration-upgrade-booking-flow.test.js` (in-place add-before-remove order, quoted-price-in-cents, abort-before-commit on blocking warning, no cancelAppointment / no fresh bookingCreate). Full suite 876 pass.

**ACTIVATION (owner-gated, do NOT skip):** A booking was destroyed before by a cancel-rebook fallback (outbound-sms #11), so the live flip requires a real-appointment dry-run with Boulevard access (Travis/Matt) proving `bookingComplete` returns the SAME appointment id (edits in place, does not mint a new appointment). Steps: (1) run the swap against one real test appointment, confirm appointment id unchanged + service now 50-min + price = quoted; (2) if confirmed, `vercel env add BOULEVARD_ENABLE_BOOKING_UPGRADE production` = `true` and redeploy; (3) canary the next live YES. If the dry-run shows a NEW appointment id, STOP and do not enable.

**Follow-up:** enrich the webhook support-incident `user_message` with the captured apply error/warnings (currently the reverify result carries them; surfacing them in the incident email is a small additive observability change).

---

### outbound-sms #14
**Status:** OPEN (queued after #13 per owner 2026-06-18)
**Severity:** customer-harm (a YES can get zero reply)
**Discovered:** 2026-06-18

**Symptom:** Owner replied YES and received no reply at all. Code returns a TwiML reply on every signature-valid inbound, and production shows zero 403s and 200s on the webhook, so the silence is not a code-logic gap.

**Root cause (leading):** The webhook does slow synchronous work before returning the reply (Google Sheets logging, Boulevard profile lookup, and the multi-call `reverifyAndApplyUpgradeForProfile` + read-back). Twilio discards a TwiML reply if the webhook does not respond within ~15s; the function's own comment budgets only 3s for "the rest of the handler" after a 12s phone-scan deadline (`route.js:35-39`), which the Boulevard apply path can exceed. When it does, the member gets nothing while Vercel logs a 200 (the function finishes after Twilio gave up) and the Google Sheet still records an outcome. Pinning a specific message requires the Twilio message log (delivery status), which needs Twilio console access.

**Fix shape:** Acknowledge the YES with an instant approved reply inside the 15s window, then do the Boulevard apply asynchronously (queue/deferred) and send the result as a follow-up message. Separate scoped PR.

---

### outbound-sms #15
**Status:** FIXED IN CODE 2026-07-22 (branch `fix/carveout-followup-hardening`, awaiting Matt's merge)
**Severity:** compliance risk (a STOP could go unrecorded)
**Discovered:** 2026-07-22 (deferred follow-up from the #86 review round)

**Symptom:** In the inbound STOP handler, the authoritative STOP-set write (`addToStopSet`) ran AFTER the slow O(N) registry cleanup scan (`removeMemberByPhone`) and inside the same try/catch. If the scan threw or hung, the STOP was never recorded in the suppression set, so an opted-out member could still receive outbound sends until Klaviyo propagation caught up.

**Fix:** `addToStopSet` now runs FIRST, and each write sits in its own try/catch, so an inbound STOP is recorded even if the registry scan throws or hangs. Three regression tests in `__tests__/twilio-webhook-route.test.js` (`inbound STOP handling`) cover: scan throws, ordering, and scan hangs.

---

### outbound-sms #16
**Status:** FIXED IN CODE 2026-07-22 (branch `fix/carveout-followup-hardening`, awaiting Matt's merge)
**Severity:** customer-annoyance / trust (duplicate "You're all set" texts)
**Discovered:** 2026-07-22 (deferred follow-up from the #86 review round)

**Symptom:** The applied-outcome follow-up SMS had no durable idempotency. The MessageSid replay cache is in-memory and per-instance, so a Twilio webhook redelivery (or a double YES) landing on a different serverless instance could re-run the deferred apply path and send the follow-up twice.

**Fix:** New `claimAppliedFollowupSend` in `src/lib/sms-member-registry.js`: a durable Redis SET NX claim with a 24h TTL, keyed `appt:<appointmentId>` (falling back to `phone:<last10>` when no appointment id survived). The webhook takes the claim AFTER the send-time STOP gate (a suppressed pass never consumes it) and BEFORE the Twilio send; anything but a fresh claim withholds the send (fail closed, at-most-once). Gauntlet follow-up (Codex P1): because the claim is itself a network await between the STOP check and the send, the route re-checks the strict STOP gate AFTER the claim and sends only on a second affirmative `off`, so a STOP landing during the claim still wins. Tests: `__tests__/sms-followup-claim.test.js` (NX semantics, TTL, fail-closed paths) plus route-level double-delivery, claim-not-burned-on-STOP, claim-refused, and STOP-during-claim tests in `__tests__/twilio-webhook-route.test.js`.

---

### outbound-sms #17
**Status:** FIXED IN CODE 2026-07-22 (branch `fix/carveout-followup-hardening`, awaiting Matt's merge)
**Severity:** PII hygiene (raw member phone numbers in error logs)
**Discovered:** 2026-07-22 (deferred follow-up from the #86 review round)

**Symptom:** Error logs on the applied follow-up send path echoed raw E.164 phone numbers: Twilio failure text includes the To number, and stop-set or claim errors can embed the number too. Vercel log drains and Sentry then hold member phone numbers in plain text.

**Fix:** `maskPhoneDigits` in the webhook route masks anything phone-shaped (8+ digits) down to `***` plus the last 4 before logging, applied to all four send-path error catches (stop-set check threw, send claim threw, stop-set recheck threw, Twilio send failed). Gauntlet follow-up (Codex P2): `claimAppliedFollowupSend` in the registry also masks long digit runs in its own failure log, since the phone-fallback claim key embeds the member's last 10 digits and a Redis error can echo the key. Tests force each error with a full E.164 embedded and assert no full number reaches the logs. Related pre-existing gap, NOT addressed here: `docs/MONITORING_SUMMARY_sms-path1.md` item 3 notes the SMS Sheet logs the outbound phone unmasked by design; that is a Sheet-scope decision, not an error-log leak.

---

## Cancel bot issues

### cancel-bot #1
**Status:** RESOLVED (process change)
**Severity:** dev-friction
**Discovered:** Feb to early March 2026

Original development chat in Claude.ai got too long, started crashing or failing to load. Lesson: start fresh chats at natural stopping points, maintain separate technical spec doc as source of truth. This is why SESSION_HANDOFF documents exist across the M-Central ecosystem.

---

### cancel-bot #2
**Status:** VERIFIED FIXED
**Severity:** prod-down for cancellation flow
**Discovered:** Early development

Bot crashed with 500 error after member provided name and email, before completing the Boulevard lookup. Combination of null-safety issues in lookup code, and the start route handler getting accidentally overwritten with rate-limiter code in a parallel session. Restored proper start route, added null-safety throughout Boulevard integration.

---

### cancel-bot #3
**Status:** RESOLVED with tradeoff
**Severity:** ux
**Discovered:** Initial production rollout

Vercel serverless cold starts plus Claude API latency made first message after inactivity noticeably slow. Fix would be Vercel Pro for faster cold starts, not done. Second and subsequent messages are fast, so most members don't notice. Acceptable as-is.

---

### cancel-bot #4
**Status:** VERIFIED FIXED
**Severity:** audit trail gap
**Discovered:** Initial production rollout

Two sheets supposed to log:
- Cancellations Sheet `1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg` (one row per session)
- Chatlog Sheet `1Wu7th9Z9tO9nQuy7j2FyEgm1YKhDwvgcVPZDprE8z-Y` (one row per message)

Chatlog logging silently no-op'd because `GOOGLE_CHATLOG_SHEET_ID` env var was not set in Vercel. Set the var, both sheets now log.

**Process gap that's a recurring theme:** Several integrations in this codebase silently no-op when env vars are missing instead of failing loudly. See cancel-bot #6.

---

### cancel-bot #5
**Status:** Decision 1 (retention aggressiveness after first clear refusal generally) FIXED IN CODE 2026-05-15 by PR `fix/retention-softening-and-credit-disclaimer`. Decision 2 (geographic exits / out-of-footprint relocation) FIXED IN CODE 2026-05-15 by PR `fix/relocation-out-of-footprint-no-retention`. Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer-harm, compliance-risk
**Discovered:** April to early May 2026 (660-session review)
**Travis decision received:** 2026-05-15 (Decision 1 + Decision 2)

Bot pushed retention past clear refusals in multiple sessions:

- Session `d60c370e`: Member said "no I would like to cancel please." Bot offered a 2-month pause. Member said "No thank you, please just cancel." Bot still ran a final-warning loss-framing block before processing. (Decision 1, still open.)
- Session `9d661a35`: Member said she was moving to Congo. Bot offered four retention options (1-month pause, bi-monthly, consolidate credits to products, final warning) before letting her cancel. Congo doesn't have a Silver Mirror. (Decision 2, fixed by this PR.)

**Travis decision (May 15 2026, Decision 2):** when a member states a relocation reason AND the destination is outside Silver Mirror's footprint (NYC, DC, Miami metros), skip the standard relocation retention sequence entirely. No pause, no bi-monthly, no credit consolidation, no final-warning loss-framing. Process the cancellation cleanly with a warm send-off acknowledging the move and one optional sentence noting the member can rejoin if they ever come back to a Silver Mirror city. In-footprint relocations preserve the existing transfer-first behavior.

**Fix (this PR, `fix/relocation-out-of-footprint-no-retention`):** new `HARD RULE - FOOTPRINT-AWARE RELOCATION HANDLING` in `src/lib/system-prompt.txt`, structured to match the PR #6 / PR #13 / PR #18 / PR #23 rule format. Four parts:
1. Classification of destinations into IN-FOOTPRINT (NYC metro 5 locations, DC metro 3 locations, Miami metro 2 locations, plus any NY/NJ/CT/DC/MD/VA/FL city or town within reach of a location) vs. OUT-OF-FOOTPRINT (international, west coast, midwest, south outside Miami metro, northeast outside NYC/DC). Ambiguous destinations get one clarifying ask: "Will you be staying in the NYC, DC, or Miami area, or moving farther?"
2. OUT-OF-FOOTPRINT handling: explicit MUST NOT list (no pause, no bi-monthly, no credit consolidation, no final warning), warm send-off "Best of luck with the move to [destination]. We've loved having you with us.", and one optional rejoin sentence.
3. IN-FOOTPRINT handling: preserves the existing decision-tree behavior (transfer first, then pause -> bi-monthly -> credit consolidation if transfer declined). PR #23 firm-refusal short-circuit and HARD RULE 1 "just cancel" honor both still apply.
4. BAD/GOOD example pairs: Congo case BAD (the actual May 6 session 9d661a35 transcript with four retention offers), Congo case GOOD (warm acknowledgment, clean cancellation, no retention), in-footprint Miami GOOD (transfer offered first), ambiguous-destination GOOD (one clarifying question then OUT-OF-FOOTPRINT handling).

Also updated Decision Tree #2 (Relocation) to point to the new hard rule: "this default sequence only applies when the destination is IN-FOOTPRINT... For OUT-OF-FOOTPRINT relocations, skip retention entirely per HARD RULE - FOOTPRINT-AWARE RELOCATION HANDLING."

19 new tests in `__tests__/claude.test.js` (`system prompt: footprint-aware relocation handling`, `prior PR rules survive the footprint-aware relocation PR`, and `no em dashes or en dashes in the new footprint-aware rule`) cover the Congo regression, in-footprint transfer-first preservation, ambiguous-destination clarifying ask, and preservation of PR #5, PR #6, PR #13, PR #18, HARD RULE #22, and PR #23. Touch: 2 files (system-prompt.txt + claude.test.js). Closes Travis Decision 2.

**Decision 1 ship (this PR, `fix/retention-softening-and-credit-disclaimer`):** new `HARD RULE - FIRM REFUSAL SHORT-CIRCUIT` in `src/lib/system-prompt.txt`, structured to match the PR #6 / PR #13 / PR #18 / PR #23 / PR #24 / PR #25 rule format. After ONE retention offer and a firm second refusal ("no", "no thank you", "just cancel", "please cancel", "cancel anyway", "I don't want it", "stop offering", etc.), the bot MUST skip the final-warning loss-framing block and process the cancellation directly. Defines "firm" vs "NOT firm" explicitly (questions, hesitation, "tell me more" do NOT trigger the short-circuit). Allows ONE clarifying question on ambiguous responses ("Just to confirm, you'd like to go ahead with the cancellation?"). Bans the loss-framing phrases the final-warning block uses ("you'll be giving up," "here's what you'd be giving up," "before you go..." etc.). The first retention offer is preserved (some members legitimately don't know pause is an option). Updates numbered HARD RULE 1 and Step 5 to cross-reference the new rule; updates the in-footprint relocation cross-reference for consistency. BAD example uses the actual Christina production transcript (session d60c370e, May 1 2026); GOOD examples cover the Christina case, soft-response retention conversation, and the ambiguous-response clarification path. 17 new tests in `__tests__/claude.test.js` cover the regression, every banned pattern, the BAD/GOOD example pairs, and no em/en dashes in the new rule. Closes Travis Decision 1.

---

### cancel-bot #6
**Status:** CODE HALF CLOSED - PR #13 (`fix/bot-no-fabricated-escalations`, 2026-05-12), PR `fix/broaden-no-process-handoff-rule` (2026-05-13), and PR `fix/escalation-cleanup-and-commitment-clarification` (2026-05-15, Decision 2 sweep) close the in-chat code half of Travis Decision 3. The 48-hour confirmation-email wording in the in-chat surface has been removed across the entire prompt (Step 6, HARD RULE 5/7/18, FAQ, booking flow, inactive-account guidance, all GOOD examples). `sendBeacon` robustness for leg-A stays AWAITING DECISION (residual Travis Decision 3)
**Severity:** trust-erosion
**Discovered:** Ongoing

Bot says things like:

- "I'm passing this to our memberships team for backend processing"
- "I've alerted our QA team"
- "I'm flagging this as urgent"
- "You'll receive a confirmation email within 48 hours"

Audit of `src/lib/notify.js`:

- "Memberships team" claim is partially real. Email to memberships@ fires (env confirmed set 2026-05-12), Google Sheet logging fires, reason-category alerts fire.
- "QA team alert" and "flagging as urgent" map to NOTHING. Bot is fabricating these (the system prompt never authorized them - the model invented them).
- "48 hours" depends on memberships team capacity, which varies.
- All of the above silently no-op if any env var is missing. Bot still tells the member they'll get an email even if the email system is broken.

**Shipped 2026-05-12 (PR #13):** added a `HARD RULE - NO FABRICATED ESCALATION` to `src/lib/system-prompt.txt` forbidding the bot from claiming it has "alerted our QA team," "flagged this as urgent," "escalated to engineering," opened a ticket, or notified any team/queue/system that does not exist; it may say only that it is passing the issue to the memberships team. Test: `__tests__/claude.test.js`. Also confirmed the env audit (memberships email infra IS configured).

**Shipped 2026-05-13 (PR `fix/broaden-no-process-handoff-rule`, in flight):** broadened the same principle to cover soft-promise language and "no defined process" issue classes. Strengthens PR #13 with additional banned patterns ("they'll resolve this," "they'll fix this," "they'll restore your credits," "they'll reach out within 24-48 hours," "they'll investigate," etc.) and adds a new `HARD RULE - NO DEFINED PROCESS HANDOFFS` mandating the Travis-decided handoff phrase: "I'm flagging this for our memberships team to review. Someone will follow up with you about next steps." This closes the code half of Travis Decision 3 (what should the bot promise when no system fires). Also adds `HARD RULE - MILESTONE DISCUSSION SCOPE` (upcoming only, no historical-perk enumeration). Tests in `__tests__/claude.test.js`. Closes cancel-bot #20 fully; materially reduces cancel-bot #11 (bot no longer recites the historical perk list as authoritative dollar values).

**Shipped 2026-05-15 (PR `fix/escalation-cleanup-and-commitment-clarification`, Decision 2 sweep):** comprehensive sweep across the entire `src/lib/system-prompt.txt` for any remaining fabricated-escalation language or specific-timeline promises not caught by PR #13 or PR #18. Found and addressed 11 in-chat instances of "within 48 hours" / "within 24-48 hours" / "within 24 hours" / "24-48 hour response time" / "they'll reach out within X hours" outside BAD example blocks and banned-list rule statements. Touched: cancellation section instruction, inactive-account guidance, FAQ contact-memberships line, booking/payment issue flow, numbered HARD RULE 5, numbered HARD RULE 7 confirmation pattern, numbered HARD RULE 18 FALLBACK, Step 6 of the cancellation flow, HARD RULE - INFINITE LOOP ESCAPE escalation path, OUT-OF-FOOTPRINT confirmation pattern, FIRM REFUSAL confirmation pattern, and two GOOD examples (PR #6 pause confirmation, FIRM REFUSAL ambiguous clarification). Preserved: 30 days written notice (legal NY auto-renewal period), 30-day processing reference (same legal notice), 90-day credit validity (defined published policy), 10-minute early arrival (booking policy), 5-day post-facial retinol wait (skincare advice), 24-hour appointment cancellation cutoff (booking policy). 31 new regression tests in `__tests__/claude.test.js` (`PR #27 Decision 2: final escalation/timeline cleanup sweep`) including a programmatic scan that asserts each banned phrase only appears inside HARD RULE BAD-example regions or banned-list rule statements. Closes the in-chat residual of Travis Decision 3.

**Still AWAITING (residual Travis Decision 3):** `sendBeacon` robustness for leg-A (separate code surface, not the in-chat prompt).

---

### cancel-bot #7
**Status:** VERIFIED FIXED
**Severity:** customer-harm (at least 3 direct cancellations caused)
**Discovered:** April to May 2026
**Resolution:** PR #6 merged May 11

Bot offered 2-month pauses, got "yes" from member, THEN revealed the 3-billing-cycle commitment in the post-acceptance message. Confirmed cases:

- Nicole (April 16): Accepted pause, learned about commitment after, cancelled outright.
- Vanessa (April 17): Same pattern.
- Emily Merghart (May 4): Same pattern. Fernanda escalated.

System prompt said "MUST disclose before confirmation." Model interpreted "before" loosely (next-message-before-action-processed) instead of strictly (same-message-as-offer). Fix tightened the rule and added an explicit BAD/GOOD example pair. 3-cycle commitment must now appear in the SAME message as the pause offer.

---

### cancel-bot #8
**Status:** VERIFIED FIXED for RETAINED outcomes
**Severity:** wrong email drafts to memberships team
**Discovered:** May 4, 2026 (Emily Merghart case)
**Resolution:** PR #4 merged May 11

Email template selector was keying off cancellation REASON instead of OUTCOME. Emily Merghart, whose reason was "Inconsistent Usage" but who accepted a 1-month pause, got an email draft with subject "Matching you with a consistent esthetician" (the lead-recommendation template) instead of a pause confirmation. Fernanda caught it before sending.

Fix: template selection keys off outcome first, with reason-based templates only firing as a fallback for RETAINED with no save offer accepted.

---

### cancel-bot #9
**Status:** VERIFIED FIXED - REFERRED routing (PR #8, May 12) + the adjacent substring-matching vuln (PR `fix/template-reason-word-boundaries`, 2026-05-12)
**Severity:** customer-harm (told a 5-year loyal member her membership was cancelled when it wasn't)
**Discovered:** May 7, 2026 (Zoe Dickinson case)
**Resolution:** PR #8 merged May 12; adjacent vuln fixed 2026-05-12

Zoe Dickinson asked about missing milestone rewards over 4+ years of fragmented account history. Bot correctly flagged session as REFERRED (not a cancellation). Email draft Fernanda received had subject "Your Silver Mirror membership cancellation is confirmed."

Two-layer root cause:

1. PR #4 fixed RETAINED template routing but didn't cover REFERRED.
2. REFERRED fell through to a reason-based substring matcher. Zoe's reason "Missing milestone rewards due to multiple account TRANSITIONS" substring-matched the "TRANSIT" / location-relocation branch by coincidence.

Fix added new template `43-referred-manual-review` and routed REFERRED to it before any reason matching.

**Adjacent vulnerability FIXED 2026-05-12** (PR `fix/template-reason-word-boundaries`): `pickTemplate` in `src/lib/member-draft.js` still ran unanchored reason regexes for RETAINED and CANCELLED outcomes, so `/transit/` matched "transitions", `/far/` matched many words, `/left/` matched "leftover", `/moving/` matched "removing", `/trip/` matched "stripe", `/ai/` matched "retain", etc. Fix: anchored the risky tokens with `\b...\b` word boundaries (`\btransit\b`, `\bfar\b`, `\bleft\b`, `\bmoving\b`/`\bmoved\b`, `\btrip`, `\bai\b`, `\bvalue\b`/`\bworth\b`, `\bboring\b`, `\bturnover`, `\bquit\b`, etc.); deliberate stems (`reloc`, `unemploy`, `dermatolog`, `inconsist`, ...) left intact. Regression tests in `__tests__/member-draft.test.js` (Zoe-style "...TRANSITIONS" no longer picks the transit template; "removing" no longer picks relocation; real "public transit"/"moving" still do).

---

### cancel-bot #10
**Status:** VERIFIED FIXED
**Severity:** margin loss on every accepted bi-monthly save
**Discovered:** May 11, 2026
**Resolution:** PR #5 merged May 11

Bot was using the member's existing (possibly grandfathered) monthly price as the bi-monthly price when offering a bi-monthly save. Bi-monthly is its own pricing tier ($99 for 30-minute, $169 for 50-minute), independent of monthly rate.

Grandfathered $89/month member was being offered bi-monthly at $89 instead of the correct $99. Revenue impact across every accepted bi-monthly save in the affected window.

Fix added centralized current bi-monthly pricing constants (the `CURRENT_BIMONTHLY_PRICING` object in `src/lib/member-draft.js`; the `pricing.js` filename referenced in older notes was never actually created). Bi-monthly offers now always quote current pricing regardless of member's existing rate.

**Price correction 2026-05-29 (Matt, owner):** the 50-minute bi-monthly rate is **$139**, not $169. The earlier $169 figure (attributed to Travis 2026-05-19) was wrong. Bi-monthly is now $99 for 30-minute and $139 for 50-minute, which means the per-cycle dollar amount equals the current monthly rate, so a member already on current pricing sees no price change when switching to bi-monthly (only grandfathered members see a change). Corrected in `member-draft.js` (`FIFTY_MINUTE: 139`), the `HARD RULE - BI-MONTHLY PRICING IS FIXED` block and all bi-monthly examples in `src/lib/system-prompt.txt`, and the related tests. The 50-minute facial *service* prices ($169 walk-in / Sensitive Skin Facial) are a different number and were left unchanged. Also confirmed: Esthetician's Choice is a 50-minute facial placeholder, not a membership tier, so it has no bearing on bi-monthly pricing. PR `fix/bimonthly-50min-price-139-2026-05-29`.

---

### cancel-bot #11
**Status:** MATERIALLY REDUCED 2026-05-13 by PR `fix/broaden-no-process-handoff-rule` (cancel-bot #20). Decision 4 still AWAITING for the residual case (bot naming the next upcoming milestone's value).
**Severity:** trust-risk, unverified data going to members
**Discovered:** Ongoing

Bot quotes specific dollar values for perks:

- "Month 2: Moisturizer ($65 value)"
- "Month 4: Hyaluronic Acid Serum ($77 value)"
- "Month 9: Cleanser ($41 value)"
- "Month 12: Foundational Formulas Bundle ($183 value)"

Nobody has verified whether these are correct, where they came from, or whether they're hard-coded versus model-fabricated. Reviewing Zoe's transcript and others, bot quotes them as authoritative facts.

**Material reduction 2026-05-13 (PR `fix/broaden-no-process-handoff-rule`):** the production-flagged failure mode here was the bot reciting a CHECKLIST of multiple historical milestones with dollar values as authoritative ("Month 2 Moisturizer $65, Month 4 HA Serum $77, Month 9 Cleanser $41, Month 12 Foundational Formulas Bundle $183..."). The new `HARD RULE - MILESTONE DISCUSSION SCOPE` forbids that enumeration regardless of how the member phrases the question. Members asking about historical perks now route to the no-defined-process handoff. The residual surface (bot naming the SINGLE next upcoming milestone with its dollar value from the static table) still has the same source-of-truth risk and stays under Travis Decision 4: verify and lock into single source of truth, drop dollar values from the upcoming-perk language entirely, or confirm already accurate.

Three options still on the table for the residual: verify and lock into single source of truth, drop dollar values entirely, confirm already accurate.

---

### cancel-bot #12
**Status:** AWAITING DECISION (Travis Decision 5)
**Severity:** compliance-risk, privacy, bad-actor risk
**Discovered:** Ongoing

Bot reveals plan, location, price, join month, perks claimed, and rate-lock savings after name + email only. It will then process pause/cancel/billing-frequency changes on that same identity check.

Anyone with another member's name and email (easy to obtain) can in theory cancel that membership. The 48-hour confirmation email is the only second factor.

Three options: keep as-is, add soft second factor (last 4 of card, last appointment date), or require click-to-confirm link in the email.

---

### cancel-bot #13
**Status:** FIXED IN CODE 2026-05-15 by PR `fix/billing-dispute-escalation-script`. Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer-harm in financially sensitive moments
**Discovered:** Ongoing
**Travis decision received:** 2026-05-15 (Decision 6)

When member alleges duplicate charges, bot said it sees one membership and asked for screenshots via email. Reads as minimizing for a moment that needs to feel taken seriously. Production case (May 2026): member alleged duplicate billing, bot's response was "I see one membership... please email screenshots", a dismissive offload that does not acknowledge the dispute.

**Travis decision (May 15 2026, Decision 6):** the bot must acknowledge billing disputes seriously, must not minimize what the member is reporting, and must use the PR #18 standard handoff phrase pattern. Per the broader PR #18 rule (Silver Mirror has no defined process for billing dispute resolution SLA), the bot must NOT promise a specific timeline ("24 hours") or a specific outcome ("they'll refund you"). Per PR #13, no fabricated escalation language ("alerted finance team," "notified billing team," etc.).

**Fix (this PR, `fix/billing-dispute-escalation-script`):** new `HARD RULE - BILLING DISPUTE HANDLING` in `src/lib/system-prompt.txt`, structured to match the PR #6 / PR #13 / PR #18 / PR #23 / PR #24 rule format. Six pieces:
1. Detection triggers covering the canonical billing-dispute phrasings ("duplicate charge," "double-billed," "charged twice," "you charged me again," "I see two charges," "wrong amount," "I was overcharged," "I want a refund" tied to a charge dispute, "I never authorized this," etc.).
2. Response pattern: acknowledge seriously (lead with empathy, not "I see one membership"), state what the bot can/cannot see (membership details yes, transaction history no, the memberships team can pull it), flag for memberships team review, optionally invite dates of disputed charges (NEVER card numbers / CVV / billing ZIP), close with the PR #18 standard handoff phrase.
3. Canonical scripted response containing the "I take this seriously" acknowledgment plus the PR #18 phrase verbatim.
4. Banned language list: dismissive readouts ("I see only one membership, so that should be correct," "looks fine on my end"), bank deflection ("It's probably a duplicate from your bank"), email-screenshots-only as the sole next step, specific timelines (per PR #18), specific outcomes (per PR #18), fabricated finance/billing team names (per PR #13).
5. Explicit exemption: refund requests that are part of a normal cancellation flow (e.g. "refund my last month as part of cancelling") still route through the standard cancellation pattern, not this dispute handoff.
6. Two BAD/GOOD example pairs: production-case BAD (the actual May 2026 dismissive script with all four banned patterns) paired with the canonical GOOD response, plus a bank-deflection BAD/GOOD pair.

Also updated the trigger pointer inside `HARD RULE - NO DEFINED PROCESS HANDOFFS` from "(treat under this rule until and unless a defined process is built)" to "(see HARD RULE - BILLING DISPUTE HANDLING below for the specific script pattern)" so the broader rule cross-references the specific one.

20 new tests in `__tests__/claude.test.js` (`system prompt: billing dispute handling`, `prior PR rules survive the billing-dispute PR`, `no em dashes or en dashes in the new billing-dispute rule`) cover the production regression, every banned pattern, the scripted response, the BAD/GOOD example pairs, and preservation of PR #5, PR #6, PR #13, PR #18, HARD RULE #22, PR #23, and PR #24. The regression test specifically asserts the GOOD production-case response: contains "take this seriously," contains the PR #18 standard handoff phrase, may invite dates, does NOT promise a 24-hour timeline, does NOT promise a refund outcome, does NOT contain dismissive phrases, does NOT punt to email-only, does NOT request card numbers/CVV. Touch: 2 files (system-prompt.txt + claude.test.js). Closes Travis Decision 6.

---

### cancel-bot #14
**Status:** FIXED IN CODE 2026-05-15 by PR `fix/retention-softening-and-credit-disclaimer`. Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** information gap in critical moments
**Discovered:** Ongoing
**Travis decision received:** 2026-05-15 (Decision 7)

Member asks "do I have any unused credits before I cancel?" Bot says it can't see specific credit details and gives a generic answer. True (bot doesn't have credit visibility), but the framing is weak. Production case (April 16 2026, session 90d9b96b): member asked whether a credit expiring June 30 was already paid for and whether cancellation would lose it; bot gave a generic "credits valid 90 days after cancellation" answer with no acknowledgment of the visibility limit. Member walked away unsure whether the answer was for THEIR credit or just policy in general.

**Travis decision (May 15 2026, Decision 7):** option B. Add explicit upfront disclaimer ("I don't have visibility into your specific credit balances") then route the member through the PR #18 standard handoff phrase. Do NOT promise a 24-hour timeline (per PR #18 / cancel-bot #20). Do NOT fabricate a specific credit count. The bot MAY still share general credit policy framed as policy.

**Fix (this PR, `fix/retention-softening-and-credit-disclaimer`):** new `HARD RULE - CREDIT VISIBILITY DISCLAIMER` in `src/lib/system-prompt.txt`, structured to match the PR #6 / PR #13 / PR #18 / PR #23 / PR #24 / PR #25 rule format. Five pieces:
1. Statement that the bot cannot see specific credit balances, expiration dates, or credit transaction history.
2. Detection triggers covering the canonical credit-visibility phrasings ("do I have any credits," "will I lose my credits if I cancel," "when does my credit expire," "is this credit already paid for," any specific credit count or date the member states, etc.).
3. Response pattern: honest upfront disclaimer ("I can see your membership details, but I don't have visibility into your specific credit balances or expiration dates."), PR #18 standard handoff phrase ("I'm flagging this for our memberships team to review your credits. Someone will follow up with you about next steps."), optional general credit policy framed as policy (90-day validity, etc.).
4. Banned language: fabricating a specific credit count, promising specific credits will be honored or restored (per PR #18), promising a specific timeline (per PR #18), stating whether a specific credit is or is not already paid for, generic policy-only answers when the member is asking about THEIR credits.
5. Explicit exemption: general-policy questions framed as policy ("how long are credits good for in general?") do NOT trigger the handoff.

BAD example uses the actual April 16 production transcript (session 90d9b96b, the June 30 credit question); GOOD examples cover the production case with disclaimer + general policy + handoff, the general-policy exemption, and a member-specific credit question combining all three elements. 19 new tests in `__tests__/claude.test.js` cover the regression, every banned pattern, the BAD/GOOD example pairs, and no em/en dashes in the new rule. Closes Travis Decision 7.

---

### cancel-bot #15
**Status:** AWAITING DECISION (Travis Decision 8)
**Severity:** brand consistency, customer perception
**Discovered:** Ongoing

Three recurring tone problems:

- "Perfect!" used as default acknowledgement, including in unresolved or neutral moments
- Stacked empathy phrases ("I hear you," "No worries," "That makes sense," "I understand") sometimes 2-3 times in adjacent messages
- Cancellation benefits list says "20% off services, add-ons, and Silver Mirror products, plus 10% off retail." Products and retail might be the same thing.

Decision favors banning default "Perfect!", limiting empathy phrases, shortening the benefits list.

---

### cancel-bot #16
**Status:** FIXED IN CODE 2026-05-15 by PR `fix/already-tried-channel-auto-escalation`. Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer frustration
**Discovered:** Ongoing
**Travis decision received:** 2026-05-15

Pattern: Member says she's been trying to cancel via email for six months. Bot suggests calling (888) 677-0055. Member says she's working and can't call. Only then does bot escalate to a human.

Bot kept deflecting to a channel the member had already exhausted, even after the member named the failed channel.

**Travis decision (May 15 2026, Decision 9):** when a member says they have already tried email, phone, the cancellation form, or another channel that did not resolve their issue, the bot must NOT redirect them back to that channel. Auto-escalate using the PR #18 standard handoff phrase, prefixed with an acknowledgement of what the member already tried so they feel heard.

**Fix (this PR):** new `HARD RULE - ALREADY ATTEMPTED CHANNEL` in `src/lib/system-prompt.txt`, structured to match the PR #6 / PR #13 / PR #18 rule format. Three pieces:
1. Detection triggers for email ("I tried emailing," "I've been emailing for months," "I sent it but never heard back"), phone ("I called and no one answered," "I left voicemails," "I can't call, I'm at work"), cancellation form ("I filled out the form," "the form didn't work"), plus passive/generic variants ("got no response," "never heard back," "I've been trying for weeks").
2. Acknowledge-then-handoff response pattern reusing the PR #18 phrase verbatim: "I see you've already tried [channel]. I'm flagging this for our memberships team to review. Someone will follow up with you about next steps." No specific timeline, outcome, or action.
3. Per-channel blocks: email tried -> do NOT suggest emailing memberships@/hello@; phone tried -> do NOT suggest (888) 677-0055 or any location phone; form tried -> do NOT suggest the cancellation form. The rule governs the escalation/handoff path only; the in-chat retention conversation (pause, downgrade, bi-monthly, etc.) is untouched.

Three BAD/GOOD example pairs cover the production case (email tried for six months), phone-tried-redirected-to-email, and form-tried-redirected-to-form. 7 new tests in `__tests__/claude.test.js` (`system prompt: already-attempted-channel auto-escalation`) cover the new rule plus preservation tests for PR #5, PR #6, PR #13, PR #18 already exist in the same file and continue to pass. Touch: 2 files (system-prompt.txt + claude.test.js). Closes Travis Decision 9.

---

### cancel-bot #17
**Status:** FIXED IN CODE 2026-05-15 by PR `fix/escalation-cleanup-and-commitment-clarification` per Travis Decision 10 (Approve). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** member confusion
**Discovered:** Ongoing
**Travis decision received:** 2026-05-15 (Decision 10)

Bot used to say "memberships have no minimum commitment, you can cancel anytime with 30 days notice." Then in the same conversation, it offered a pause with a 3-billing-cycle commitment. Side by side, confusing.

**Travis decision (May 15 2026, Decision 10):** standardize the language so both halves are distinguishable and non-contradictory. Membership-level: no minimum commitment. Special-schedule (pause or bi-monthly) level: 3-billing-cycle commitment applies. Both statements are true but apply to different things.

**Fix (this PR):** updated three locations in `src/lib/system-prompt.txt` with the standardized commitment clarification:
1. **FAQ MEMBERSHIP CREDITS section** (formerly the one-line "No minimum commitment, cancel with 30 days notice"): now reads "There is no minimum commitment to be a member. You can cancel anytime with 30 days written notice. The 3-billing-cycle commitment only applies if you accept a pause or switch to bi-monthly billing. Those are special schedules that need a few cycles of regular billing on either side to work."
2. **PR #6 GOOD pause example** (numbered HARD RULE 4): updated to include both halves in the same offer message, preserving the PR #6 same-message-disclosure rule.
3. **Numbered HARD RULE 17 (bi-monthly script)**: added the commitment clarification inline, so the 3-cycle commitment is disclosed in the same message as the bi-monthly offer.

5 new tests in `__tests__/claude.test.js` (`PR #27 Decision 10: standardized commitment language`) cover the FAQ pattern, the GOOD pause example, the bi-monthly script update, and the both-halves-distinguishable invariant. Closes Travis Decision 10.

---

### cancel-bot #18
**Status:** FIXED IN CODE 2026-05-14 by PR `fix/template-routing-reason-vs-offer`. Bump to VERIFIED FIXED after merge + production deploy and a clean follow-on RETAINED + non-pause session.
**Severity:** customer-harm (wrong template into the memberships team queue; required manual rewrite before send)
**Discovered:** May 6, 2026 (Rose Williamson session, Fernanda escalation)

Rose Williamson session: outcome RETAINED, reason Travel, accepted Bi-monthly billing. Email template `01-travel-pause` fired with subject "Your Silver Mirror membership pause is confirmed" and no mention of bi-monthly. Fernanda rewrote it by hand before send.

PR #4 made offer-acceptance beat reason for RETAINED routing for many reason categories, but inside the RETAINED block the offer-type detectors ran in the order `isPause` -> `isDowngrade` -> `isBimonthly` -> `isTransfer`. When the LLM-generated `offer_accepted` summary string contained both "bi-monthly" and "pause" (e.g. "Bi-monthly billing instead of 2-month pause"), `isPause` fired first and the Travel reason fell into `tmplTravelPause`, producing a pause-confirmation email for a member who did not pause.

**Fix in `src/lib/member-draft.js`:** the RETAINED block now evaluates accepted-offer types from most-specific to least-specific: bi-monthly, transfer, downgrade, then pause. Bi-monthly, transfer, and downgrade hard-route to their own templates regardless of reason; pause then keeps its reason-aware sub-routing (Travel, Medical, Lost Job, Forgot, Voucher, default Cost). The existing `30-cost-bimonthly` template (subject "Your Silver Mirror bi-monthly billing is confirmed") is reused, no new template needed. Regression test covers RETAINED + Travel + Bi-monthly accepted (both clean and pause-mixed offer_accepted strings); preservation tests retain Emily Merghart pause routing, Travel + Pause, Zoe Dickinson REFERRED routing, and all CANCELLED-outcome cases.

**Audit findings surfaced but NOT fixed in this PR (one-fix-per-PR rule):**
1. **Inconsistent Usage + Pause accepted** routes to `29-cost-pause`. Body mentions rate-lock, not the inconsistency issue. Acceptable default, no customer-harm. Documented in existing test (Emily Merghart).
2. **Forgot + Bi-monthly accepted** routes to `30-cost-bimonthly` (generic). No `forgot-bimonthly` variant exists.
3. **Voucher + Bi-monthly accepted** routes to `30-cost-bimonthly` (generic). No `voucher-bimonthly` variant exists.
4. **Travel + Downgrade accepted** routes to `28-cost-downgrade`. Reads acceptably, no Travel-aware downgrade copy.
5. **Reaction + Pause accepted** routes to `29-cost-pause` (no reaction-pause; the reaction-specific templates `20-reaction-callback` and `21-reaction-free-calming` only fire when no save offer was accepted).
6. **Relocation + Pause accepted** routes to `29-cost-pause` (no relocation-pause; transfer is the relocation-specific save).

Travel + Bi-monthly was the only audited combination producing customer-facing misrepresentation (the email subject contradicted the action taken). The others produce reasonable defaults; if any of them surfaces a customer complaint, fold a reason-specific variant in its own PR.

---

### cancel-bot #19
**Status:** Part 1 VERIFIED FIXED in PR #19 (REFERRED -> `43-referred-manual-review` routing, merged 2026-05-12). Part 2 FIXED IN CODE 2026-05-15 by PR `fix/email-placeholder-string-sanitization` (placeholder sanitization in `src/lib/member-draft.js`). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer-harm (a non-cancelled member received a cancellation-confirmed email; a raw template placeholder rendered verbatim in a member-facing email)
**Discovered:** May 10, 2026 (Sindhura Polepalli session, Fernanda escalation)

Sindhura Polepalli session: outcome REFERRED, reason Technical Issue (credits disappeared during pause). Two distinct failures in the one session:

1. **Wrong template (FIXED, PR #19):** `42-generic-cancelled` fired with subject "Your Silver Mirror membership cancellation is confirmed." Sindhura was REFERRED, not CANCELLED. Her session was May 10; PR #8 (REFERRED routes to `43-referred-manual-review`) merged May 12, so her session predates the fix. Verified by reading the Cancellations Google Sheet for REFERRED sessions on or after 2026-05-13. No further regressions observed.

2. **Placeholder bled into member-facing email (FIXED, PR `fix/email-placeholder-string-sanitization`, 2026-05-15):** body contained the literal string `Your existing credits (5 (missing from display)) are usable for 90 days`. The nested `(missing from display)` is the upstream "I can't resolve this" placeholder the bot emits when it cannot verify the count, and pre-fix that string interpolated raw into every template that referenced `${s.unused_credits}`. The fix adds a sanitization layer in `src/lib/member-draft.js`: a new `isPlaceholderValue` helper flags values containing "missing from display", "unknown", "TBD", an empty string, or any stray parenthesis, and a `creditsParen` helper returns either a clean ` (N)` suffix or an empty string. Every `unused_credits` interpolation across 14 templates was updated to use the helper, including the special-case `tmplVoucherCredit` where the count appears inline. Unsafe values now produce coherent neutral wording (e.g. "Your existing credits are usable for 90 days from your last charge date") rather than the raw placeholder. 13 new tests cover the Sindhura regression, every credits-bearing template, and preservation of legitimate values ("0", "3", undefined, empty). Helper is reusable for any future field that shows the same class of bug.

---

### cancel-bot #20
**Status:** FIXED IN CODE 2026-05-13 by PR `fix/broaden-no-process-handoff-rule` (PR 1 of the May 13 ship sequence, not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** trust-erosion across two issue classes (milestone history per Zoe; technical/credit issues per Sindhura)
**Discovered:** May 7, 2026 (Zoe Dickinson follow-up); Travis decision received 2026-05-12

Two-part Travis ruling resolving the operational gap behind cancel-bot #9 and cancel-bot #19:

1. **Milestone scope.** Silver Mirror has no defined process for fragmented-account milestone reconciliation. The bot should mention only UPCOMING milestones, never enumerate historical perks the company has no defined process to honor. Zoe's transcript (the bot reciting "Month 2: Moisturizer ($65 value)... Month 9: Cleanser ($41 value)...") is exactly the pattern to remove.

2. **Generic no-SLA escalation language.** For any issue class with no defined SLA (milestone history per Zoe; technical/credit issues per Sindhura; adjacent classes), the bot says exactly: "I'm flagging this for our memberships team to review. Someone will follow up with you about next steps." No specific timeline, no "48 hours," no outcome promise.

**PR 1 landed 2026-05-13 (`fix/broaden-no-process-handoff-rule`)** with three edits to `src/lib/system-prompt.txt`: (a) new `HARD RULE - MILESTONE DISCUSSION SCOPE` constraining milestone discussion to the member's NEXT upcoming milestone only, with BAD/GOOD example pair drawn from the Zoe transcript (Month 2/4/5/9/12 historical recital banned); (b) new `HARD RULE - NO DEFINED PROCESS HANDOFFS` mandating Travis's exact phrase "I'm flagging this for our memberships team to review. Someone will follow up with you about next steps." with documented contextual variations ("review your account history" / "review your credits" / "review this") and explicit bans on specific timelines, outcomes, and actions; covers Zoe + Sindhura plus the broader class (missing milestones, credits/points/perks not showing, fragmented account history, technical/display issues, duplicate-charge billing disputes); (c) strengthened `HARD RULE - NO FABRICATED ESCALATION` (PR #13) with "Additional banned soft-promise patterns" listing the Sindhura-class language ("they'll resolve this," "they'll restore your credits," "they'll reach out within 24-48 hours," "they'll investigate," etc.) plus a BAD/GOOD example pair from the Sindhura transcript. 18 new tests in `__tests__/claude.test.js` (regression for both production cases plus preservation tests for PR #5, PR #6, PR #13, and HARD RULE #22). Touch: 2 files. Together with PR #13 (no fabricated escalation) this closes the substantive code half of cancel-bot #6 / Travis Decision 3. Smallest blast radius of the four May 13 PRs (system prompt + tests only, no code paths touched), largest production-flagged surface. The remaining piece of Decision 3 (whether to keep the literal "48-hour confirmation email" wording in the outcome-notification path, separate from the in-chat escalation language) stays AWAITING.

---

### cancel-bot #23
**Status:** FIXED IN CODE 2026-05-16 by PR `feat/first-offer-positive-emotional-reframing` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** ux, brand warmth (positive customer suggestion, not a regression)
**Discovered:** May 4, 2026 (Fernanda forward of customer feedback; the same Fernanda escalation that originated cancel-bot #18 / #19). Travis approval received 2026-05-15.

Customer-originated suggestion forwarded by Fernanda on May 4 2026: members responding to the cancellation widget asked the bot to acknowledge the positive reasons they signed up in the first place, not only frame the conversation around what they would lose by cancelling. Specific customer phrasings cited: "developing a self-care routine that works" and "the issue I was experiencing has cleared." The current first retention offer is purely transactional (offer the decision-tree save without any emotional framing); customers reading the transcripts felt this was tone-deaf for what is, for many of them, a self-care investment they made deliberately.

This is NOT a customer-harm bug. The existing flow is technically correct and PR #26 already addresses the over-retention failure mode (firm-refusal short-circuit). The opportunity here is brand warmth: connect the first offer to why members joined, before the offer itself. Surfaced alongside the harder Fernanda escalations (#18 Rose Williamson Travel-bi-monthly mis-template, #19 Sindhura Polepalli REFERRED routing + placeholder leak) but separately scoped because it is a content/tone change, not a routing or correctness fix.

**Travis decision (May 15 2026):** approve a FIRST OFFER ONLY warmth/reframing pattern. The bot may include a warm acknowledgment that connects to why the member joined Silver Mirror (healthier skin, self-care routine, investing in themselves, the skincare journey) inside the first retention offer message. Strict scope: FIRST OFFER only, must coexist cleanly with PR #26 firm-refusal short-circuit, must not become a new retention-pressure layer, must not be applied to reason categories that already route differently (Relocation, Technical Issue, Billing Dispute, Schedule Conflict).

**Fix (this PR, `feat/first-offer-positive-emotional-reframing`):** new `HARD RULE - FIRST OFFER POSITIVE EMOTIONAL REFRAMING` in `src/lib/system-prompt.txt`, structured to match the PR #6 / PR #13 / PR #18 / PR #23 / PR #24 / PR #25 / PR #26 rule format. Six pieces:
1. Permission framing (PERMITTED, not required) and scope (FIRST retention offer message only, never standalone, never a second offer).
2. Suggested patterns the bot may rework contextually (four canonical examples covering different first-offer shapes: pause, downgrade, AI skin scan, lead recommendation).
3. USE list: Cost / Cost Overwhelming, Inconsistent Usage / Forgot Benefits / Inconsistent Experience, No Value / Lack of Value, Lack of Results / No Results, Bad Experience.
4. NOT USE list with explicit cross-references: Relocation (HARD RULE - FOOTPRINT-AWARE RELOCATION HANDLING), Technical Issue (HARD RULE - NO DEFINED PROCESS HANDOFFS), Billing Dispute (HARD RULE - BILLING DISPUTE HANDLING), Schedule Conflict (administrative), the SECOND or LATER retention offer, any time AFTER a firm refusal (HARD RULE - FIRM REFUSAL SHORT-CIRCUIT wins), clarification questions and the cancellation processing step itself.
5. Strict guardrails: ONCE per session, no loss-framing combination, no health/treatment claims that overpromise, no specific products/perks by name, no empathy-phrase stacking, no application when the member has expressed frustration/anger/urgency, framing immediately followed by offer in SAME message (no split).
6. Eight BAD examples (warmth after firm refusal, warmth combined with loss-framing, warmth in second offer, warmth applied to Relocation, Technical Issue, Billing Dispute, Schedule Conflict, plus implicit "must not stack with empathy phrases") and three GOOD examples (Cost reason warmth + offer, Inconsistent Usage reason warmth + offer with PR #6 commitment disclosure intact, FIRST OFFER framing offered ONCE then dropped cleanly on firm refusal demonstrating PR #26 still wins).

30 new tests in `__tests__/claude.test.js` (`system prompt: first-offer positive emotional reframing rule`, `PR #28 coexists with PR #26 firm-refusal short-circuit`, `PR #28 does not regress any prior PR rule`, `no em dashes or en dashes in PR #28 edits`) covering: rule presence, permitted-not-required framing, customer-suggestion origin citation, journey-language anchors (healthier skin / self-care routine / invest / journey), the four suggested patterns, USE list, NOT USE list with all cross-references, every guardrail individually, each BAD example for each banned context, both GOOD example shapes (warmth + offer in same message for Cost and for Inconsistent Usage), the warmth-offered-once-then-dropped GOOD example with PR #26 short-circuit firing correctly, plus preservation tests for PR #5, PR #6, PR #13, PR #18, PR #22, PR #23, PR #24, PR #25, PR #26 (FIRM REFUSAL SHORT-CIRCUIT + CREDIT VISIBILITY DISCLAIMER), PR #27, and no em/en dashes in the new section. Total test count after this PR: 528 passing across the suite (was 498 before this PR).

Touch: 3 files (`src/lib/system-prompt.txt`, `__tests__/claude.test.js`, `QA_ISSUES.md`). Closes the customer-suggestion implementation for the Fernanda May 4 2026 forward.

---

### cancel-bot #24
**Status:** FIXED IN CODE 2026-05-19 (commit pending). Bump to VERIFIED FIXED after the next production session that hits a service-quality complaint comes through without a cross-location lead or invented connection program.
**Severity:** trust erosion (the memberships team has to walk back a promise the bot made about a specific named person)
**Discovered:** 2026-05-19 (Fernanda forwarded the CANCELLED Megan Bruns case to Travis and Matt)

**Production case:** CANCELLED Megan Bruns, Navy Yard, 2026-05-18. Bot transcript excerpt:
> "One option would be connecting you with Karen, our Experience Ambassador at Navy Yard. She's specifically trained to ensure members have consistently great experiences and could work with you directly on any service concerns."

Followed by:
> "Karen would definitely value hearing your perspective."

**What actually happened (corrected during cross-reference review):** Karen IS in the `LOCATION LEADS ROSTER` at lines 428-438 of `src/lib/system-prompt.txt`, BUT she is the Bryant Park lead, NOT the Navy Yard lead. The correct Navy Yard lead per the same roster is Nique. So the bot's failure was cross-location lead assignment, not pure name invention. The "specifically trained to ensure members have consistently great experiences" framing and the "could work with you directly on any service concerns" outreach promise are both fabricated connection programs with no defined Silver Mirror process behind them.

Fernanda's original flag asserted (a) no staff member named Karen at Navy Yard, (b) Experience Ambassador is not a role, (c) the promised feedback call has no execution path. Items (a) and (c) are correct as stated. Item (b) is technically incorrect against the system prompt as written (Experience Ambassador is documented for 6 leads, Support Ambassador for 4 more), which surfaces a separate question for Fernanda and Travis: is the Experience/Support Ambassador program operationally real, or is it prompt fiction that should be removed entirely? That question is OUT OF SCOPE for this PR and left as follow-up.

**Distinct from PR #27 (`fix/escalation-cleanup-and-commitment-clarification`):** PR #27 and the broader `HARD RULE - NO FABRICATED ESCALATION` family swept "I've alerted our QA team," "escalated to engineering," "opened a ticket," etc. Those are fabricated DEPARTMENT escalations. This rule covers a sibling pattern: "Let me connect you with [named person] at [location]" handoffs that invent a specific human, a specific title, or a connection program. The two rule families share the same false-promise root cause but the BAD/GOOD example patterns differ enough to warrant a separate rule.

**Fix (this PR, commit pending):** new `HARD RULE - NO FABRICATED STAFF NAMES, ROLES, OR CONNECTION PROGRAMS` in `src/lib/system-prompt.txt`, placed between `HARD RULE - NO FABRICATED ESCALATION` and `HARD RULE - NO DEFINED PROCESS HANDOFFS` (its closest siblings). Narrow scope per Matt's 2026-05-19 decision:
- BANS cross-location lead assignment (a roster lead may not be claimed for any location other than the one listed in the roster).
- BANS inventing a staff name when the roster does not list one for the location.
- BANS inventing job titles ("Member Success Manager," "Regional Director," "Customer Experience Manager," "Member Care Coordinator," "Wellness Specialist," "Brand Manager," and the open-ended class of invented roles) outside the two documented titles (Experience Ambassador, Support Ambassador).
- BANS named-person connection programs ("would love to hear from you," "I'll have [name] reach out to you directly," "I can connect you with [name] for a feedback call," "[name] would definitely value hearing your perspective").
- PERMITS the existing decision-tree Lead recommendation offers for reasons 4, 7, 8, 9, 10, 11, 17, 18, 20 when the roster lists a lead for the member's location.
- PRESERVES `HARD RULE #16` ("Use lead names from roster. Never generic.") and the `LOCATION LEADS ROSTER` itself.

Five BAD examples (Megan Bruns transcript verbatim, invented role and name, invented role with soft outreach, correct roster name combined with fabricated connection program, correct location with named lead permitted for decision-tree path) and three GOOD examples (decision-tree lead recommendation at correct location, no-defined-process handoff for broader feedback ask, manager-call path without named lead). 8 new tests in `__tests__/system-prompt-no-fabricated-staff.test.js`: rule presence, Megan Bruns case citation (member name + date + location), cross-location ban, invented-title bans by listed example, fabricated-connection-program ban, fallback handoff phrase, LOCATION LEADS ROSTER preserved, decision-tree Lead recommendation offers still present.

Touch: 3 files (`src/lib/system-prompt.txt`, `__tests__/system-prompt-no-fabricated-staff.test.js`, `QA_ISSUES.md`).

**Open follow-up RESOLVED 2026-05-19 (Travis):** Travis (Director of Operations) confirmed: "Those are real people, but they act as lead estheticians to train our staff, they're not really consumer facing from that point of view." So the roster names ARE real internal staff, but Experience Ambassador / Support Ambassador are internal training-team designations with no operational member-outreach process behind them. The bot was using these as a customer-facing retention play that does not exist operationally.

**Follow-up PR (commit pending) addresses the broader correction:**
- Strips "(Experience Ambassador)" and "(Support Ambassador)" from any customer-facing path (the roster data at lines 428-438 of `src/lib/system-prompt.txt` stays as internal reference data).
- Removes "Lead recommendation" as a retention offer from every decision-tree path where it appeared: Reasons 4 (New Provider), 7 (Repetitive), 8 (Esthetician Turnover), 9 (No Results), 10 (No Personalized Plan), 11 (Reaction), 13 (Inexperienced Esthetician), 17 (Medical), 18 (Inconsistent Experience), 20 (Lack of Value). Also strips "Free add-on with lead," "Free facial with lead," and "Lead for calming" qualifiers wherever they appeared.
- Adds new `HARD RULE - SERVICE QUALITY DISCOVERY STEP` for vague service-quality complaints (Reasons 12 Front Desk Issues, 13 Inexperienced Esthetician, 18 Inconsistent Experience): bot asks ONE open-ended follow-up before retention or handoff. If the member declines, bot does not ask again.
- Rewrites HARD RULE #16. Old: "Use lead names from roster. Never generic." New: marks the LOCATION LEADS ROSTER as internal-only, bans naming specific leads in member-facing output, bans surfacing the two titles in member-facing output, bans named-lead connection offers. Cites Travis 2026-05-19 by date.
- Updates the 244978f HARD RULE PERMITTED section (removes the two named-lead allowances) and GOOD examples (no longer recommend "Vanessa, our Experience Ambassador at Flatiron"). The 244978f rule itself is preserved.
- 10 new tests in `__tests__/system-prompt-no-named-leads.test.js`: "Lead recommendation" removed from decision tree, "with lead" qualifiers removed, HARD RULE #16 rewritten, SERVICE QUALITY DISCOVERY STEP added, PERMITTED section updated, GOOD examples updated, all 20 reasons preserved, service-quality reasons reference the discovery rule, roster preserved as internal data, 244978f rule preserved.
- 1 test removed and 1 updated in `__tests__/system-prompt-no-fabricated-staff.test.js` (the "preserves decision-tree Lead recommendation offers" assertion and the "Use lead names from roster" assertion are now obsolete).

Net effect on the cancellation flow: vague service-quality complaints now route through a discovery question + decision-tree offer that does not involve a named human; structured complaints with specifics route through the same decision-tree offers without a named lead. The memberships team handles all named-staff follow-up downstream of the session summary email. Test suite: 554 passing (was 545 after 244978f; net +9 from this PR after offsetting removed assertions).

---

### cancel-bot #25
**Status:** FIXED IN CODE 2026-05-27 by Phase 2 of branch `fix/cancel-bot-decision-audit-2026-05-27` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** brand consistency, member confusion on retail discount
**Discovered:** 2026-05-27 (Phase 2 of decision-tree audit, prompted by Travis's clarification that the three discount tiers should be presented as distinct categories, not collapsed)

The bot was collapsing three distinct member-discount tiers into wording like "20% off services and products, 10% off retail" or "20% off facials, add-ons, and Silver Mirror products, 10% off retail". This conflates Silver Mirror's own product line (20% off) with other-brand retail (10% off), and members reading the collapsed wording had no way to tell that the in-shop Revision/IS Clinical/Sanitas/EmerginC/Dr. Dennis Gross/Skinceuticals products are at a different discount rate than Silver Mirror's own line.

**Fix (Phase 2):** new `HARD RULE - MEMBER DISCOUNT THREE-CATEGORY STRUCTURE` in `src/lib/system-prompt.txt`. Three categories the bot must keep distinct:
1. Services: 20% off (additional facials beyond the included monthly facial, add-ons, peels, microchanneling)
2. Silver Mirror products: 20% off (Silver Mirror's own skincare line)
3. Non-Silver Mirror retail: 10% off (other brands carried in shop)

Updates to MEMBER PERKS section, KNOWLEDGE BASE: PRODUCTS & RETAIL, and PROMOTIONS POLICY general-deals answer ensure the three tiers are presented as distinct lines. Shorthand "your 20% member discount" is allowed in brief Final Warning enumerations (preserves Christina / Benjamin existing examples) because it doesn't assert a single rate across categories. If the member asks for the breakdown, the bot gives all three. Banned collapsed phrasings: "20% off everything", "20% off services and products", "20% off all purchases", "20% off facials, add-ons, and products, plus 10% off retail".

5 regression tests in `__tests__/claude.test.js` (`system prompt: Phase 2 three-category member discount structure`). Closes the benefits-list piece of Travis Decision 8. The tone-cleanup piece (Perfect!, empathy stacking) is in cancel-bot #28.

---

### cancel-bot #26
**Status:** FIXED IN CODE 2026-05-27 by Phase 4 of branch `fix/cancel-bot-decision-audit-2026-05-27` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** trust-risk, unverified data going to members
**Discovered:** Ongoing (escalation of cancel-bot #11)
**Travis decision context:** Decision 4 (Perk dollar values) — Katie owned the verification ask and has been unresponsive for 3+ weeks since the 2026-05-05 decisions doc. Per Matt's 2026-05-27 call, default to STRIP rather than continue waiting.

Cancel-bot #11 was MATERIALLY REDUCED by PR `fix/broaden-no-process-handoff-rule` (the milestone enumeration ban) but the residual surface — bot naming the single next upcoming milestone WITH a dollar value pulled from the static prompt table — still carried the same source-of-truth risk. Members were being quoted "$65 moisturizer", "$77 serum", "$41 cleanser", "$183 bundle" without those values being verified against any operational truth.

**Fix (Phase 4):** strip all `$XX value` and `worth $XX` annotations from the prompt and add `HARD RULE - NO PERK DOLLAR VALUES`. Names and timing (Month 2, Month 4, etc.) preserved as accurate operational truth. Exception: Enhancement Credit dollar amounts (Months 22, 42, 54, 78, 90, 102, 114) preserved because the dollar amount IS the perk identity, not a value annotation on a different perk.

Edits to `src/lib/system-prompt.txt`:
- MEMBER PERKS MILESTONES table: 14 `$XX value` annotations stripped (Month 2, 4, 5, 6, 9, 12, 18, 24, 36, 48, 72, 84, 96, 108)
- LOYALTY POINTS redemption table: 6 `$XX value` annotations stripped (500-8,000 pts tiers)
- Zoe BAD example in HARD RULE - MILESTONE DISCUSSION SCOPE: 5 `$XX value` annotations stripped from the enumerated perk list; added explanatory sentence noting two banned patterns are stacked
- Benjamin GOOD example in HARD RULE - GUEST DEMANDS: "Hyaluronic Acid Serum worth $77" -> "Hyaluronic Acid Serum"
- Christina BAD example in HARD RULE - FIRM REFUSAL SHORT-CIRCUIT: "Cleanser, $41 value" -> "Cleanser"
- New HARD RULE - NO PERK DOLLAR VALUES with triggers, MAY-say list, MUST-NOT-say list, Enhancement Credit exception, BAD/GOOD examples, and reopen path (if Katie or another owner later provides a verified single-source-of-truth value table, the rule can be relaxed)

8 regression tests in `__tests__/claude.test.js` (`system prompt: Phase 4 perk dollar values stripped + HARD RULE banning quoted amounts`). Closes the Decision 4 residual via the strip path. If Katie later provides verified values, reopen the rule, not the prompt.

---

### cancel-bot #27
**Status:** FIXED IN CODE 2026-05-27 by Phase 5 of branch `fix/cancel-bot-decision-audit-2026-05-27` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** trust-erosion (false promises on human-team response)
**Discovered:** May 10 2026 (Sindhura Polepalli production case, originally captured under cancel-bot #19 / #20)

Sindhura case: bot said "they'll reach out within 24 to 48 hours to resolve this" on behalf of the memberships team. The team's response time and outcome are not within the bot's visibility, so the promise damaged member trust when it did not hold.

PR #13 (no-fabricated-escalation) and PR #18 (no-defined-process handoffs) already covered the major sub-cases. This phase adds an umbrella HARD RULE that consolidates the principle: the bot does not promise specific timelines, outcomes, or actions on behalf of ANY human team at Silver Mirror, even when the team is real and the routing is correct.

**Fix (Phase 5):** new `HARD RULE - NO HUMAN-TEAM SLA PROMISES` in `src/lib/system-prompt.txt`, placed between HARD RULE - NO FABRICATED ESCALATION and HARD RULE - NO FABRICATED STAFF NAMES.

Coverage:
- Applies to memberships team, location manager, location front desk, individual estheticians, "the team at [location]", generic "team", any human team
- Banned timeline patterns (15+ phrasings: "within 24 hours", "within 48 hours", "within 24 to 48 hours", "within an hour", "by tomorrow", "by end of day/week", "this week", "this morning", "this afternoon", "in the next X hours/days", weasel "shortly"/"soon", any "within X" or "by [day/time]" tied to follow-up)
- Banned outcome patterns (9 phrasings: "they'll fix this", "they'll resolve this", "they'll restore [X]", "they'll refund you", "they'll calculate", "they'll audit", "they'll address this", "they'll investigate", "they'll pull your transaction history")
- Banned action patterns (5+ phrasings: "they'll reach out", "they'll call you", "they'll email you", "they'll set up a meeting", any specific action guarantee)
- GOOD pattern: generic "Someone will follow up with you about next steps." / "Our memberships team will follow up directly."
- What this rule DOES allow: defined policies (30-day processing, 90-day credit validity), routing to a real channel without timeline, manager-escalation safety paths (escalation can be promised; timing cannot)
- Cross-references to all related rules (NO FABRICATED ESCALATION, NO DEFINED PROCESS HANDOFFS, BILLING DISPUTE HANDLING, CREDIT VISIBILITY DISCLAIMER, ALREADY ATTEMPTED CHANNEL)
- BAD/GOOD example pairs: Sindhura credits case (canonical), manager-callback with vs without timeline, location-team follow-up with vs without timeline

7 regression tests in `__tests__/claude.test.js` (`system prompt: Phase 5 HARD RULE - NO HUMAN-TEAM SLA PROMISES`), plus a global scan that asserts every "within 24" or "within 48" reference in the prompt sits inside an Example BAD, banned-list, or rule-body context. Closes the umbrella consolidation of Decision 3 hardening.

---

### cancel-bot #28
**Status:** FIXED IN CODE 2026-05-27 by Phase 6 of branch `fix/cancel-bot-decision-audit-2026-05-27` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** brand consistency, tone-deafness in cancellation flows
**Discovered:** Ongoing (per cancel-bot #15 and Decision 8 voice/tone cleanup)
**Decision context:** Decision 8 (Voice and tone cleanup, "Perfect!" overuse, empathy phrase stacking). Katie owned; been unresponsive 3+ weeks since the 2026-05-05 decisions doc. Per Matt's 2026-05-27 call, ship the strip now.

The bot's recurring pattern of leading with "Perfect!" (in cancellation lookups, after firm refusals, in send-offs) and stacking two or three empathy phrases per response ("I hear you. That makes sense. No worries.") makes it sound robotic and, in cancellation flows specifically, tone-deaf. Sindhura case 2026-05-11 and multiple other production sessions show this pattern.

**Fix (Phase 6):** new `HARD RULE - FILLER PHRASE CONTROL` in `src/lib/system-prompt.txt`, placed after HARD RULE - FIRST OFFER POSITIVE EMOTIONAL REFRAMING.

Coverage:
- Banned in MEMBERSHIP MODE entirely: "Perfect!", "Perfect,", "Perfect." as default acknowledgment of any member response in cancellation, pause, downgrade, or billing-dispute flows. Also "Awesome!", "Amazing!", "Excellent!" as defaults.
- Substitutes: "Got it,", "Okay,", "Done.", "Thank you for telling me,", or no acknowledgment when the next sentence carries the response forward.
- Empathy phrase cap: AT MOST ONE empathy phrase per response from {"I hear you", "No worries", "That makes sense", "I understand", "Thanks for sharing that", "I'm sorry that's how it's felt", "I hear that"}. Never stack two or three.
- GENERAL MODE: less strict. "Perfect!" permitted in genuinely positive moments (e.g., booking just confirmed). No empathy stacking.
- Step-of-flow specifics: lookup confirmation, offer presentation, offer acceptance, offer refusal (firm), confirmation/send-off all get neutral acknowledgment ("Got it,").
- BAD/GOOD example pairs for Perfect! in lookup, Perfect! after acceptance, three-phrase empathy stack, two-phrase stack across adjacent responses, Perfect! in send-off.

Also updated TONE & FORMATTING MEMBERSHIP MODE block to add the new constraints inline and cross-reference the HARD RULE.

7 regression tests in `__tests__/claude.test.js` (`system prompt: Phase 6 HARD RULE - FILLER PHRASE CONTROL`), plus a global scan asserting every "Perfect!" in the prompt sits inside HARD RULE - FILLER PHRASE CONTROL itself or an Example BAD / banned-list / rule cross-reference context. Closes the tone-cleanup piece of Travis Decision 8. The benefits-list piece is cancel-bot #25.

---

### cancel-bot #29
**Status:** FIXED IN CODE 2026-05-27 by Phase 7 of branch `fix/cancel-bot-decision-audit-2026-05-27` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** outcome integrity (pause request silently processed as cancellation)
**Discovered:** Session d16f133e (date unconfirmed; cited in Matt's 2026-05-27 audit brief as a pause request that may have converted to a cancellation)

Pause and cancellation are different outcomes with different downstream consequences (pause keeps the membership active with 3-billing-cycle commitment; cancellation starts the 30-day legal notice period and ends rate lock + benefits). Session d16f133e suggested the bot processed a pause request as a cancellation, or at minimum failed to distinguish the two intents. The existing cancellation flow (Step 1-6, Decision Tree #1-#20) treats every membership conversation as a cancellation candidate, so a clean pause-only request would be misclassified if the bot defaulted to running the cancellation retention tree.

**Fix (Phase 7):** new `HARD RULE - PAUSE VS CANCEL INTENT BOUNDARY` in `src/lib/system-prompt.txt`, placed between HARD RULE - FIRM REFUSAL SHORT-CIRCUIT and HARD RULE - CREDIT VISIBILITY DISCLAIMER.

Coverage:
- Detection triggers for PAUSE intent ("pause", "hold", "freeze", "1-month hold", "step back")
- Detection triggers for CANCEL intent ("cancel", "end", "I'm done", "close my account", "stop my membership")
- Detection triggers for AMBIGUOUS intent ("take a break", "stop paying for now", compound asks)
- Five response patterns: pause-first opens (treat as pause, not cancellation), cancel-first opens (treat as cancellation, decision tree may offer pause as Step 4 save), ambiguous opens (one clarifying question with canonical phrasing), intent shift mid-flow from pause to cancel (stop pause flow, switch to cancellation), intent shift mid-flow from cancel to pause (stop cancellation, switch to pause)
- Banned patterns: auto-converting pause to cancel or vice versa, marking wrong outcome, saying "processing your cancellation" when only a pause was requested
- Outcome categorization grid: 5 scenarios mapped to RETAINED vs CANCELLED
- BAD/GOOD example pairs for pause auto-converted to cancellation, ambiguous intent without clarification, intent shift bot ignored

Preserves existing pause-as-save-offer pattern (cancel intent + pause offered + pause accepted = RETAINED) and all decision-tree pause-first paths (Travel, Relocation, Shifted to Derm, New Provider, Forgot Benefits, Voucher Build-Up, Cost Overwhelming, Lost Job, Medical). PR #6 same-message commitment disclosure cross-referenced.

8 regression tests in `__tests__/claude.test.js` (`system prompt: Phase 7 HARD RULE - PAUSE VS CANCEL INTENT BOUNDARY`). Closes the pause/cancel boundary surface from session d16f133e.

---

### cancel-bot #30
**Status:** FIXED IN CODE 2026-05-28 by branch `fix/cancel-bot-code-level-sla-and-perk-enforcement` (not yet merged; depends on the decision-audit branch merging first). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** trust-erosion (banned SLA language reached members through code paths that bypass the LLM)
**Discovered:** 2026-05-27 (Codex review of the decision-audit branch flagged this as P2)

The decision-audit branch (commit ac3769e) added `HARD RULE - NO HUMAN-TEAM SLA PROMISES` to the system prompt, banning "within 24-48 hours" and "alerted our QA team" style promises. Codex's review on that branch surfaced that the rule doesn't reach deterministic fallback responses in `src/app/api/chat/message/route.js`: `buildSupportIncidentResponse` (called for booking/payment incidents), `buildLookupFailureMessage` (second-attempt cancellation lookup failures), and the inactive-account + cancel-intent branch of `buildPostLookupGreeting` all emitted hardcoded strings that bypass Claude entirely. A member hitting any of those paths still saw the banned SLA language.

**Fix (this PR, `fix/cancel-bot-code-level-sla-and-perk-enforcement` commit 2260fb4):** four hardcoded user-facing strings updated to match the GOOD pattern from HARD RULE - NO HUMAN-TEAM SLA PROMISES ("Someone will follow up with you about next steps") and HARD RULE - NO FABRICATED ESCALATION (no fake teams):

1. `buildSupportIncidentResponse` (line 127): stripped "I've alerted our QA team and logged this issue for follow-up." (fabricated team, two violations stacked: NO FABRICATED ESCALATION + NO HUMAN-TEAM SLA PROMISES) and "We aim to respond within 48 hours" (timeline promise). Replaced with "I'm flagging this for follow-up." + "Someone will follow up with you about next steps." Phone path and troubleshooting-detail ask preserved.
2. `buildPostLookupGreeting` inactive-account + cancel-intent branch (line 437): "they will follow up within 24-48 hours" -> "someone will follow up with you about next steps."
3. `buildLookupFailureMessage` second-attempt variant A (line 477): "The memberships team replies within 24-48 hours and can complete the cancellation process for you" -> "The memberships team can complete the cancellation process. Someone will follow up with you about next steps."
4. `buildLookupFailureMessage` second-attempt variant B (line 478): "The memberships team can locate the account and handle cancellation within 24-48 hours" -> "The memberships team can locate the account and handle the cancellation. Someone will follow up with you about next steps."

Routing/conditional logic of every fallback preserved unchanged - only the user-facing strings rotated. The three helper functions are now exported so a dedicated test file can assert the strings directly.

12 regression tests in `__tests__/chat-message-fallback-sla-strings.test.js` cover: no timeline patterns in any fallback, no fabricated-QA-team language in the support-incident response, GOOD pattern usage (flag for follow-up + phone path + troubleshooting ask), no em dashes in any fallback string, attempt 1 lookup-failure stays SLA-free, and an end-to-end source scan that no live (non-comment) line in route.js contains any banned SLA pattern. Closes the prompt-vs-code-path gap that Codex's review exposed.

---

### cancel-bot #31
**Status:** FIXED IN CODE 2026-05-28 by branch `fix/cancel-bot-code-level-sla-and-perk-enforcement` (not yet merged; depends on the decision-audit branch merging first). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** trust-risk (unverified perk dollar amounts continued to surface to members)
**Discovered:** 2026-05-27 (Codex review of the decision-audit branch flagged this as P2)

The decision-audit branch (commit 5980dbc) stripped `($XX value)` annotations from the static `MEMBER PERKS MILESTONES` and `LOYALTY POINTS` tables in `src/lib/system-prompt.txt` and added `HARD RULE - NO PERK DOLLAR VALUES`. Codex's review surfaced that those values still flowed into the prompt at runtime via `formatProfileForPrompt` in `src/lib/boulevard.js`: the function emitted `Next Perk Milestone: Month N — Name ($XX value)` and `Loyalty Redeemable: Name (M points = $XX value)`. HARD RULE #22 explicitly tells the bot to use the injected "Next Perk Milestone" field, so members were still seeing the unverified amounts the static-table strip was supposed to remove.

**Fix (this PR, `fix/cancel-bot-code-level-sla-and-perk-enforcement` commit 7d68c9d):** `formatProfileForPrompt` updated to strip the value annotations at injection time. Specifically:

1. Loyalty Redeemable line: `(N points = $XX value)` -> `(N points)`. Point cost and service name are operational truth; the dollar value is unverified retail-equivalent and carries the same source-of-truth risk that motivated the Phase 4 strip.
2. Next Perk Milestone line: `Month N — Name ($XX value)` -> `Month N, Name`. The `($XX value)` annotation is stripped for all perks. Enhancement Credit dollar amounts ($50 across Months 22, 42, 54, 78, 90, 102, 114) are preserved because they live INSIDE the perk NAME field (e.g., "$50 Enhancement Credit"), which IS the perk identity, not a value annotation.
3. Em dashes inside perk names (from the `PERK_MILESTONES` source data, e.g., "Year 3.5 Mid-Year — $50 Enhancement Credit") are defensively replaced with commas at injection time so the rendered profile complies with the global no-em-dash rule the prompt enforces.
4. UNKNOWN placeholder strings throughout the function: 8 em dashes in "UNKNOWN — do not state X" / "UNKNOWN — do not mention X" patterns replaced with commas ("UNKNOWN, do not state X" etc.). These were previously leaking into the prompt.

`PERK_MILESTONES` source data (lines 220-249 of `boulevard.js`) NOT touched. The em dashes in those name strings are defensively replaced at injection time by the formatter. A future cleanup PR could update `PERK_MILESTONES` directly, but that touches an inner data structure and was out of scope for this P2 fix per Matt's instructions (only the `formatProfileForPrompt` display function is in scope; the underlying constants are HARD STOPS).

`HARD RULE #22` ("For perk messaging, use ONLY the injected 'Next Perk Milestone' + 'Months Until Next Perk' fields. Do not infer perk timing from the static milestone table.") still makes sense after the strip - the rule tells the bot to use the injected fields and not infer; the injected fields are just now value-free.

No downstream parser of these strings exists - they are display-only, formatted into the prompt for the LLM to read. Verified via grep: the only references to "Next Perk Milestone" / "Loyalty Redeemable" in `src/` are the formatter itself and the system-prompt.txt HARD RULE #22 reference.

12 regression tests in `__tests__/boulevard-format-profile-prompt-no-perk-values.test.js` cover: no "= $XX value" annotation in the Loyalty Redeemable line, no "($XX value)" annotation in the Next Perk Milestone line (iterated across 6 sample perks), Enhancement Credit identity preservation, mid-year Enhancement Credit em-dash-to-comma conversion, Months Until Next Perk arithmetic, missing-field handling, em-dash defense across all perk names, and an end-to-end scan that no banned `$XX value` pattern appears anywhere in the rendered profile.

---

## Cross-cutting issues

### cancel-bot #22
**Status:** FIXED IN CODE 2026-05-15 by PR `fix/session-summary-server-side-date` (not yet merged). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer-harm (corrupted canonical cancellation record), trust-erosion
**Discovered:** May 13, 2026 (PR #4 verification work, while reading the Cancellations Google Sheet)

The bot was emitting a `date` field as part of the structured `session_summary` JSON, and `notify.js` wrote it verbatim to column A of the Cancellations Google Sheet (and into the summary email subject line and the reason-alert email). Bot-generated dates have hallucinated wrong values in production:

- Zoe Dickinson: actual session 2026-05-07, Sheet row dated `2024-12-19`
- Sindhura Polepalli: actual session 2026-05-10, Sheet row dated `2025-01-27`

Concrete downstream harm: Fernanda's queue ordering by date is wrong (she misses fresh escalations because they sort with two-year-old rows); trend analysis is unreliable (May 2026 looks sparse because hallucinated rows file under 2024 and 2025); audit trails are noise; date-filtered Sheet queries return near-empty results when sessions actually exist under hallucinated dates.

Cross-references PR #4 (`fix/email-template-outcome-priority`, May 11) which surfaced the issue during its post-merge sheet-reading verification work but did not touch the date field. Same root cause class as cancel-bot #6 / cancel-bot #20: bot output that the system trusts as authoritative when it shouldn't.

**Fix (this PR):** three changes:
1. **Strip the date field from the bot's output schema.** `src/lib/system-prompt.txt`: removed `"date": "[ISO date]"` from the `session_summary` JSON example and added a new `HARD RULE - SESSION SUMMARY DATE FIELD` explicitly instructing the bot not to emit a date field, citing both production cases. The server now stamps the date.
2. **Stamp date server-side at session end.** `src/app/api/chat/end/route.js`: a `todayInEastern()` helper (tiny `Intl.DateTimeFormat` call, no library) returns today's date in `America/New_York` as `YYYY-MM-DD`, and `summary.date` is overwritten with that value immediately before `processConversationEnd` is called. Even if the bot emits a date field anyway, it is overwritten and ignored.
3. **Defense in depth in `notify.js`.** A new `safeIsoDate(value)` helper passes through any string matching `^\d{4}-\d{2}-\d{2}$` and otherwise returns today's Eastern date in the same `YYYY-MM-DD` format. Applied to `logToGoogleSheets` (column A), `buildEmailBody` (text email), and `buildEmailHtml` (HTML email header). This catches any session that bypasses the end-route stamping path (e.g. older queued sessions, future call sites) and refuses to write a malformed value.

17 new tests in `__tests__/session-summary-date-stamping.test.js`: prompt-no-longer-has-date assertions, regression tests for both Zoe and Sindhura production cases (bot-supplied hallucinated date is overwritten by `todayInEastern()`), `safeIsoDate` defense-in-depth coverage (missing/malformed/non-string/whitespace), preservation tests (other summary fields untouched, GENERAL conversations bypass notify entirely, fallback path still stamps date). Touch: 4 files (system-prompt.txt, route.js, notify.js, new test file). Existing notify, chat-message, and member-draft tests still pass; the 10 pre-existing failures on main (1 in `claude.test.js` for a stale assertion, 9 across the SMS cron tests) are unrelated to this PR.

**Surfaced but not fixed in this PR:** sparse-May-2026-rows in the Cancellations Sheet is a downstream observability question. Once new sessions land with the corrected server-stamped date, count May rows again over a multi-day window. If the count is still surprisingly low, that is its own investigation (Sheet write reliability, session-end handler reach, etc.) and gets its own ticket. Out of scope here.

---

### cross-cutting #1
**Status:** BUILT 2026-05-12 (PR #11 `feat/sms-zero-send-alert`, builds on PR #10 `feat/sms-daily-send-counter`)
**Severity:** detection gap that allowed a 3-week prod outage
**Discovered:** May 5, 2026

No health-check alerting on outbound SMS sends. April-May outage went undetected for 3 weeks because the detection mechanism was "Matt happens to check the Sheet."

**Fix:** `src/lib/sms-metrics.js` tracks a daily send count in Redis (`sms-sent:<YYYY-MM-DD>`, 3-day TTL), bumped on every successful Twilio send in `/api/sms/automation/pre-appointment`. A new daily cron `/api/cron/sms-health-check` (`0 14 * * *` ≈ 9-10 AM ET, after the previous day's send window has closed) reads yesterday's count and, if it is below `SMS_MIN_DAILY_SENDS` (default 1), emails `EMAIL_ESCALATION` (fallback `EMAIL_TO`) with a triage checklist. Tests: `__tests__/sms-metrics.test.js`, `__tests__/sms-health-check-route.test.js`. Note: the day right after a deploy may produce one false-positive alert (no counter history yet) - the alert email says so.

---

### cross-cutting #2
**Status:** SCAFFOLDED 2026-05-12 (PR `test/conversation-evals-and-staging-doc`)
**Severity:** structural test coverage gap
**Discovered:** Ongoing

The unit suite covers template selection, parsing, etc., but nothing exercises the bot's actual conversational behavior. "Does the bot honor 'just cancel' after a clear refusal" is the kind of check that would have caught cancel-bot #5 before a guest got hurt.

**Built:** `__tests__/conversation-eval.test.js` - plays scripted conversations against the real Claude API and checks responses against the rules behind real incidents: honor "just cancel" after repeated refusals (cancel-bot #5), no fabricated escalation like "alerted our QA team" (cancel-bot #6), the 3-billing-cycle commitment disclosed in the same message as a pause offer (cancel-bot #7). Skipped by default (LLM calls are slow / non-deterministic / billable); run with `RUN_CONVERSATION_EVALS=1 ANTHROPIC_API_KEY=... npx vitest run __tests__/conversation-eval.test.js` when changing `system-prompt.txt`. Assertions are lenient regex checks - a failure is a strong signal, a pass is "no obvious regression." Adding more scenarios as new bot rules land is the ongoing follow-up.

---

### cross-cutting #3
**Status:** PARTIAL (scope-lock rules now exist in PR prompts)
**Severity:** structural risk
**Outstanding since:** Ongoing

Parallel agents (Claude Code, Cursor, Codex) have made uncoordinated changes that broke things. Three of the recent cancel-bot issues trace to template-selection logic refactored without considering all outcome types. The 5-fix bundle on outbound SMS (#7) is the most blatant example.

Mitigations in place: handoff docs, PR scope-lock rules, this `QA_ISSUES.md` file. Durable answer needs a clear "who owns what" map across agents.

---

### cross-cutting #4
**Status:** ADDRESSED 2026-05-12 (PR `chore/env-validation-at-boot`)
**Severity:** trust-erosion plus silent prod failures
**Discovered:** Ongoing

Multiple integrations silently no-op when env vars are missing instead of failing loudly. This pattern caused cancel-bot #4 (Chatlog Sheet) and is the structural enabler of cancel-bot #6 (fabricated escalation promises).

**Fix:** `src/lib/validate-env.js` now defines a per-subsystem env map (`boulevard`, `email`, `sheets`, `redis`, `twilio`, `klaviyo`, `sms_cron`) and is wired into `src/instrumentation.js` so `validateEnv()` runs once at server boot - on every deploy you now get a loud `[env]` log block listing exactly which subsystems are degraded/disabled and which vars are missing (the observability that was the actual gap; the integration modules themselves already return `{ logged:false, reason:... }` / `{ sent:false, reason:... }` rather than truly silent no-ops). `assertSubsystem(name)` is exported so new integration code can fail closed explicitly. Test: `__tests__/validate-env.test.js`. (Retrofitting `assertSubsystem` into every existing module is a larger, lower-urgency follow-up - the boot-time visibility plus the existing per-call `reason` returns cover the practical risk.)

---

### cross-cutting #5
**Status:** PARTIAL - existing safe-test paths documented 2026-05-12 (PR `test/conversation-evals-and-staging-doc`); a dedicated staging project is still a provisioning decision
**Severity:** quality gate gap
**Discovered:** Ongoing

No fully-isolated staging environment. Every change ships to the one production project and runs against real guest data.

**Documented (`docs/STAGING.md`):** the ways to verify a change without a real send or a real conversation - `dryRun: true` on `/api/sms/automation/pre-appointment` (full pipeline, no Twilio call); synthetic mode on `/api/qa/upgrade-check` (`QA_SYNTHETIC_MODE_TOKEN` + `syntheticProfile`/`syntheticAppointments`/`syntheticCandidates`, zero Boulevard calls); the conversational evals (cross-cutting #2); Vercel preview deployments (with the caveat that they share production env vars). **Still open:** a real `sm-member-cancel-staging` Vercel project with its own env vars (Boulevard sandbox, test Twilio number or `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=true`, separate Redis namespace, separate Sentry project). That requires creating a new billable project and was intentionally not done unilaterally - it's a call for whoever owns the Vercel team. See `docs/STAGING.md` "The real gap."

---

### cross-cutting #6
**Status:** VERIFIED FIXED 2026-05-19 (PR #31 `fix/sms-cron-observability-masking`, merged to main `1bb7d96`)
**Severity:** detection gap that hid a 5-day prod outage
**Discovered:** 2026-05-17

**Symptom:** Outbound SMS outage that started May 12 (outbound-sms #10) ran undetected until May 17 when the daily zero-send alert finally fired.

**Root cause:** `checkOneCandidate` in `src/app/api/cron/sms-upgrade-scan/route.js` had four compounding observability defects:
1. `res.json().catch(() => ({}))` swallowed HTML responses into `{}`
2. No `res.ok` check, so 401/403/500 were treated identically to 200
3. `ok: true` was hardcoded in the `.then` arm regardless of HTTP status
4. The summary builder bucketed candidates with no recognized reason into `skippedByReason["unknown"]` (a skip), not as errors

Result: `summary.errors` stayed at 0 throughout the outage. Vercel runtime logs showed every cron run as "ok" with `skippedByReason: {unknown: N}`. The daily zero-send alert was the only structural signal, and it took 5 days to fire.

**Fix:** PR `fix/sms-cron-observability-masking` rewrote `checkOneCandidate` to check `res.ok` before parsing, route HTTP failures into the errors bucket with reason `http_<status>`, return errors for JSON parse failures with reason `non_json_response`, added a `httpStatusCodes` histogram to the summary, elevated the summary log to `console.error` when `errors > 0`, and added an inline ops email alert (rate-limited to once per hour via Redis SET NX) when a single cron run shows `sent=0` and `errors>0`.

The daily zero-send alert cron at `sms-health-check` is intentionally untouched. It is correct. After this fix it becomes the backstop, not the primary signal.

**Verification:** Verified 2026-05-19 via SSO-protected URL injection on preview deployment (branch `chore/test-observability-failure-injection`, now deleted): cron returned `summary.errors=1, summary.httpStatusCodes['401']=1, summary.sent=0, errorsByReason={"http_401":1}`; one ops alert email received at EMAIL_ESCALATION (rerouted to matt@ at the time, see cross-cutting #7 for the subsequent split); second cron tick within the same hour produced the same JSON shape but no duplicate email (Redis SET NX dedupe held).

---

### cross-cutting #7
**Status:** FIXED IN CODE 2026-05-19 (PR pending env var provisioning)
**Severity:** misrouted guest escalation surfaced in owner's inbox
**Discovered:** 2026-05-19

**Symptom:** A cancel bot guest escalation email ("CANCELLED - Nicole Smith - Location Closure") arrived in matt@silvermirror.com on 2026-05-19. The memberships team did not receive it. The email should have routed to hello@silvermirror.com.

**Root cause:** On 2026-05-19 the production EMAIL_ESCALATION env var was rerouted from hello@silvermirror.com to matt@silvermirror.com so that the new sms-upgrade-scan HTTP failure alerts and the daily zero-send alerts (see cross-cutting #1 and #6) would surface in Matt's private inbox. The reroute was too broad: EMAIL_ESCALATION is also consumed by `sendSummaryEmail` in `src/lib/notify.js` (lines around 235), where it controls cancel bot guest escalation CC routing for upset-sentiment sessions, reaction cases, location closures, and billing disputes. Every cancel bot escalation between the reroute and the discovery silently shifted from the memberships team to Matt.

**Fix:** Splits ops alerts (`EMAIL_OPS_ALERTS`) from guest escalations (`EMAIL_ESCALATION`).
- `sendOpsAlertEmail` in `src/lib/notify.js` now reads `EMAIL_OPS_ALERTS` exclusively, with a hardcoded literal fallback to `matt@silvermirror.com` (so ops alerts can never silently route to a customer-facing inbox if the env var is missing).
- `sendSummaryEmail` continues to read `EMAIL_ESCALATION` unchanged; `EMAIL_REACTION_ALERTS` routing is untouched.
- `.env.example` documents both vars with comments explaining the split.
- 3 tests added in `__tests__/notify.test.js` covering: `EMAIL_OPS_ALERTS` set, `EMAIL_OPS_ALERTS` unset (literal fallback), and the explicit non-consultation of `EMAIL_ESCALATION`.

**Post-merge env changes (Matt runs in Vercel):** add `EMAIL_OPS_ALERTS=matt@silvermirror.com` to production/preview/development; revert `EMAIL_ESCALATION` to `hello@silvermirror.com` in production/preview/development; trigger a production redeploy.

**Stale doc references not updated in this fix (historical records):** `QA_ISSUES.md` cross-cutting #1 says the daily zero-send alert emails `EMAIL_ESCALATION`; cross-cutting #6 verification note above refers to "EMAIL_ESCALATION"; `docs/SESSION_HANDOFF_2026-05-16.md` and `docs/PLAN_sms-outage-fix_2026-05-17.md` reference `EMAIL_ESCALATION` as the ops recipient. After this fix, both `sms-health-check` and `sms-upgrade-scan` route through `sendOpsAlertEmail`, which now reads `EMAIL_OPS_ALERTS`. The historical docs were accurate at the time of writing and are not retroactively edited.

**Verification plan:** After the env var changes, Matt sends a manual escalation through the cancel bot (or waits for an organic one) and confirms hello@/memberships@ receives the email rather than matt@. Separately, the next sms-health-check or sms-upgrade-scan ops alert continues to land in matt@.

---

## Travis decisions ledger

The 10 chatbot-script decisions parked with Travis for review, mirrored from `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`. This list is the authoritative cross-reference between decision number and issue number.

| Decision | Issue | Topic | Stakes |
|---|---|---|---|
| 1 | cancel-bot #5 | Retention aggressiveness after first clear refusal | high (FTC) | FIXED IN CODE 2026-05-15 (PR `fix/retention-softening-and-credit-disclaimer`) |
| 2 | cancel-bot #5 | Retention behavior on geographic/medical exits | high | FIXED IN CODE 2026-05-15 (PR `fix/relocation-out-of-footprint-no-retention`, geographic half only; medical exits still default to Decision Tree #17) |
| 3 | cancel-bot #6 / #27 / #30 | Escalation reality vs fabricated promises | HIGHEST | IN-CHAT CODE HALF CLOSED end-to-end as of 2026-05-28: static prompt via PR #13, PR `fix/broaden-no-process-handoff-rule`, PR `fix/escalation-cleanup-and-commitment-clarification`, and Phase 5 of `fix/cancel-bot-decision-audit-2026-05-27` (NO HUMAN-TEAM SLA PROMISES umbrella); deterministic server-side fallbacks via `fix/cancel-bot-code-level-sla-and-perk-enforcement` (closes the gap Codex's review surfaced). `sendBeacon` robustness for leg-A still residual. |
| 4 | cancel-bot #11 / #26 / #31 | Perk dollar value verification | medium | FIXED IN CODE end-to-end as of 2026-05-28: static prompt table stripped via Phase 4 of `fix/cancel-bot-decision-audit-2026-05-27`; runtime injection (`formatProfileForPrompt`) stripped via `fix/cancel-bot-code-level-sla-and-perk-enforcement`. Both branches awaiting merge. Reopen-on-Katie-data path documented in HARD RULE |
| 5 | cancel-bot #12 | Identity verification floor | high (privacy) |
| 6 | cancel-bot #13 | Refund / double-billing escalation script | medium | FIXED IN CODE 2026-05-15 (PR `fix/billing-dispute-escalation-script`); Phase 1 lock-in regression test added 2026-05-27 |
| 7 | cancel-bot #14 | Credit visibility approach | medium | FIXED IN CODE 2026-05-15 (PR `fix/retention-softening-and-credit-disclaimer`); OPEN CONFLICT surfaced 2026-05-27 in docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md for Matt to resolve (Vote A/B reconciliation) |
| 8 | cancel-bot #15 / #25 / #28 | Tone fixes (Perfect!, empathy, benefits list) | low-medium | FIXED IN CODE 2026-05-27 (Phase 2 benefits 3-tier + Phase 6 FILLER PHRASE CONTROL in `fix/cancel-bot-decision-audit-2026-05-27`) |
| 9 | cancel-bot #16 | Channel-loop rule (don't redirect to failed channels) | medium | FIXED IN CODE 2026-05-15 (PR `fix/already-tried-channel-auto-escalation`); Phase 3 lock-in regression test added 2026-05-27 |
| 10 | cancel-bot #17 | Commitment language standardization | medium | FIXED IN CODE 2026-05-15 (PR `fix/escalation-cleanup-and-commitment-clarification`) |

---

## What a healthy state looks like

When all five top-of-list items above are closed and the 10 Travis decisions are shipped:

- Every claim the bot makes maps to a real system that fires verifiably
- Retention stops after one or at most two clear refusals, always
- Identity verification is strong enough to prevent bad-actor cancellations
- Email and Sheet logging is monitored, with zero-send alerting catching outages within 24 hours
- Bi-monthly pricing, perk dollar values, and channel deflection language all have single sources of truth
- The cron `summary.sent > 0` shows healthy candidate flow every business day
- Vitest covers conversational behavior, not just template selection

---

## Update protocol

When you ship a fix:

1. Find the matching issue number above
2. Change status to VERIFIED FIXED (with PR reference) or NOT YET VERIFIED (with PR reference)
3. Update the date at the top of this file
4. If your fix surfaced an adjacent vulnerability, open a new numbered issue (don't reuse numbers)
5. Commit this file in the same PR as your fix

When you discover a new issue:

1. Add it under the right system (outbound-sms or cancel-bot or cross-cutting)
2. Use the next sequential number for that system
3. Fill in all fields (system, severity, status, discovered date)
4. Cross-reference any related Travis decision number if applicable
5. If it's an open prod-down or customer-harm issue, also add it to the top-of-list summary

Numbers do not get reused. Skipped numbers stay skipped.
