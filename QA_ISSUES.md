# QA_ISSUES.md - sm-member-cancel

**Purpose:** Canonical, living ledger of every known production issue across the cancel bot and outbound SMS systems in this repo. Read this before opening any PR. Update this when shipping a fix or surfacing a new issue.

**Last updated:** May 15, 2026 (billing dispute handling rule)
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

**Production escalations from Fernanda (May 6-10), shipping May 13 in corrected order:**

1. **cancel-bot #20 (and code half of cancel-bot #6)** - FIXED IN CODE 2026-05-13 by PR `fix/broaden-no-process-handoff-rule` (PR 1 of the May 13 sequence, not yet merged). Three edits to `src/lib/system-prompt.txt`: (a) new `HARD RULE - MILESTONE DISCUSSION SCOPE` (upcoming only, no historical-perk enumeration like Zoe got); (b) new `HARD RULE - NO DEFINED PROCESS HANDOFFS` mandating Travis's exact phrase "I'm flagging this for our memberships team to review. Someone will follow up with you about next steps." with bans on specific timelines, outcomes, and actions; (c) strengthened PR #13's `HARD RULE - NO FABRICATED ESCALATION` with Sindhura-class soft-promise example bans ("they'll resolve this," "they'll reach out within 24-48 hours," etc.). 18 new tests cover both production cases plus PR #5/#6/#13 preservation. Bump to VERIFIED FIXED after merge + production deploy.
2. **cancel-bot #19 part 1** - Sindhura Polepalli (May 10) REFERRED + Technical Issue routed to `42-generic-cancelled`; her session predates PR #8 merge May 12. PR 4 reads the Cancellations Google Sheet to confirm REFERRED sessions on or after 2026-05-13 route to `43-referred-manual-review` (not `42-generic-cancelled` or any other template). Verification only, no code change unless a regression is surfaced.
3. **cancel-bot #18** - Rose Williamson (May 6): RETAINED + Travel + accepted Bi-monthly routed to `01-travel-pause` instead of a bi-monthly confirmation. Fernanda rewrote by hand. PR 2 in `src/lib/member-draft.js`: audit every accepted-offer × reason combination, make accepted-offer the primary key for RETAINED template routing (reason-templates as fallback only when no save offer was accepted), and add a bi-monthly confirmation template if one doesn't already exist. Closes the gap PR #4 left in RETAINED routing.
4. **cancel-bot #19 part 2** - FIXED IN CODE 2026-05-15 by PR `fix/email-placeholder-string-sanitization`. Sindhura's email body contained the literal placeholder string `Your existing credits (5 (missing from display)) are usable for 90 days`. PR adds an `isPlaceholderValue` + `creditsParen` sanitization layer in `src/lib/member-draft.js` (matches "missing from display", "unknown", "TBD", empty string, and any stray parenthesis), then applies it to every `unused_credits` interpolation across 14 templates plus the special-case voucher-credit conversion template. 13 new tests cover the Sindhura regression, every credits-bearing template, and preservation of legitimate values. Bump to VERIFIED FIXED after merge + production deploy. Part 1 (REFERRED routing) was already verified fixed in PR #19.

**Ship order today:** PR 1, PR 4, PR 2, PR 3. PR 1 smallest scope and biggest surface (system prompt only). PR 4 verification only (Sheet read). PR 2 and PR 3 both touch `member-draft.js` in different functions; PR 2 first so its audit can surface fields PR 3 needs to know about.

**Still parked behind Travis decisions or provisioning calls:**

4. **cancel-bot #5** - Bot pushes retention past clear refusals. Customer harm and FTC Negative Option exposure. Decision 2 (geographic exits / out-of-footprint relocation) FIXED IN CODE 2026-05-15 by PR `fix/relocation-out-of-footprint-no-retention` (Congo case fix: HARD RULE - FOOTPRINT-AWARE RELOCATION HANDLING skips retention entirely for moves outside NYC/DC/Miami metros, preserves in-footprint transfer-first behavior, 19 new tests). Decision 1 (retention aggressiveness after first clear refusal generally) still AWAITING Travis.
5. **cancel-bot #12** - Identity verification is name + email only; the bot then processes pause/cancel/billing changes on that. Privacy and bad-actor risk. AWAITING Travis Decision 5.
6. **cancel-bot #6 (broader)** - The fabricated-escalation prompt guardrail shipped (PR #13). The generic no-SLA escalation language and the strengthened example bans resolve via cancel-bot #20 / PR 1. Whether/how to soften the "48-hour confirmation email" promise in the outcome-notification path (separate from in-chat escalation language) and the `sendBeacon` robustness for leg-A are still AWAITING Travis Decision 3.
7. **cancel-bot #11 / #14 / #15 / #17** - the rest of the Travis decisions (perk dollar values; credit visibility; tone; commitment language). Code is mostly trivial; the calls aren't ours. (cancel-bot #16 / channel-loop rule resolved 2026-05-15 by PR `fix/already-tried-channel-auto-escalation` per Travis Decision 9. cancel-bot #13 / refund-double-billing script resolved 2026-05-15 by PR `fix/billing-dispute-escalation-script` per Travis Decision 6.)
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
**Status:** Decision 2 (geographic exits / out-of-footprint relocation) FIXED IN CODE 2026-05-15 by PR `fix/relocation-out-of-footprint-no-retention`. Bump to VERIFIED FIXED after merge + production deploy. Decision 1 (retention aggressiveness after first clear refusal generally) still AWAITING.
**Severity:** customer-harm, compliance-risk
**Discovered:** April to early May 2026 (660-session review)
**Travis decision received:** 2026-05-15 (Decision 2 only; Decision 1 still open)

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

**Still AWAITING Decision 1:** how aggressive should retention be after the first clear refusal generally (not just geographic exits). The `d60c370e` session is the canonical example. Final-warning loss-framing after a clear "just cancel" is still allowed by the prompt outside the OUT-OF-FOOTPRINT path.

---

### cancel-bot #6
**Status:** CODE HALF CLOSED - PR #13 (`fix/bot-no-fabricated-escalations`, 2026-05-12) plus PR `fix/broaden-no-process-handoff-rule` (2026-05-13, not yet merged) close the code half of Travis Decision 3. The 48-hour confirmation-email wording in the outcome-notification path (separate from in-chat escalation language) and the `sendBeacon` robustness for leg-A stay AWAITING DECISION (residual Travis Decision 3)
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

**Still AWAITING (residual Travis Decision 3):** whether to soften the literal "48-hour confirmation email" wording in the outcome-notification path (separate code surface from the in-chat escalation language); `sendBeacon` robustness for leg-A.

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

Fix added centralized current bi-monthly pricing constants in `pricing.js`. Bi-monthly offers now always quote current pricing regardless of member's existing rate.

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
**Status:** AWAITING DECISION (Travis Decision 7)
**Severity:** information gap in critical moments
**Discovered:** Ongoing

Member asks "do I have any unused credits before I cancel?" Bot says it can't see specific credit details and gives a generic answer. True (bot doesn't have credit visibility), but the framing is weak.

Three options: wire in credit visibility, add explicit upfront disclaimer plus 24-hour follow-up, or status quo.

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
**Status:** AWAITING DECISION (Travis Decision 10)
**Severity:** member confusion
**Discovered:** Ongoing

Bot says "memberships have no minimum commitment, you can cancel anytime with 30 days notice." Then in the same conversation, it offers a pause with a 3-billing-cycle commitment. Side by side, confusing.

Proposed standardized language pending Travis review.

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

## Travis decisions ledger

The 10 chatbot-script decisions parked with Travis for review, mirrored from `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`. This list is the authoritative cross-reference between decision number and issue number.

| Decision | Issue | Topic | Stakes |
|---|---|---|---|
| 1 | cancel-bot #5 | Retention aggressiveness after first clear refusal | high (FTC) |
| 2 | cancel-bot #5 | Retention behavior on geographic/medical exits | high | FIXED IN CODE 2026-05-15 (PR `fix/relocation-out-of-footprint-no-retention`, geographic half only; medical exits still default to Decision Tree #17) |
| 3 | cancel-bot #6 | Escalation reality vs fabricated promises | HIGHEST |
| 4 | cancel-bot #11 | Perk dollar value verification | medium |
| 5 | cancel-bot #12 | Identity verification floor | high (privacy) |
| 6 | cancel-bot #13 | Refund / double-billing escalation script | medium | FIXED IN CODE 2026-05-15 (PR `fix/billing-dispute-escalation-script`) |
| 7 | cancel-bot #14 | Credit visibility approach | medium |
| 8 | cancel-bot #15 | Tone fixes (Perfect!, empathy, benefits list) | low-medium |
| 9 | cancel-bot #16 | Channel-loop rule (don't redirect to failed channels) | medium | FIXED IN CODE 2026-05-15 (PR `fix/already-tried-channel-auto-escalation`) |
| 10 | cancel-bot #17 | Commitment language standardization | medium |

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
