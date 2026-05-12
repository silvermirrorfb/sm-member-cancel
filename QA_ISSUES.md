# QA_ISSUES.md - sm-member-cancel

**Purpose:** Canonical, living ledger of every known production issue across the cancel bot and outbound SMS systems in this repo. Read this before opening any PR. Update this when shipping a fix or surfacing a new issue.

**Last updated:** May 12, 2026
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

The issues most worth knowing about right now, in order of stakes:

1. **cancel-bot #5** - Bot pushes retention past clear refusals. Customer harm and FTC Negative Option exposure. AWAITING Travis Decisions 1 and 2 (how aggressive after a clear refusal; geographic/medical exits).
2. **cancel-bot #12** - Identity verification is name + email only; the bot then processes pause/cancel/billing changes on that. Privacy and bad-actor risk. AWAITING Travis Decision 5.
3. **cancel-bot #6 (broader)** - The fabricated-escalation prompt guardrail shipped 2026-05-12, but whether/how to soften the "48-hour confirmation" promise and the `sendBeacon` robustness for leg-A are still AWAITING Travis Decision 3.
4. **cross-cutting #4** - Several integrations silently no-op when an env var is missing instead of failing loudly (was the cause of cancel-bot #4, structural enabler of #6). `src/lib/validate-env.js` exists but is not wired to fail closed everywhere. Recurring root cause.
5. **cross-cutting #2** - No conversational integration tests. 269 Vitest tests, almost all template/unit; nothing exercises "does the bot honor 'just cancel' after a clear refusal" - the kind of test that would catch cancel-bot #5 before a guest gets hurt.

**Recently fixed (all 2026-05-12):** outbound-sms #8 (cron now uses per-location appointment discovery, not random registry sampling - verified sending, PR #9); cross-cutting #1 (daily send counter + zero-send alert cron, PRs #10-11); error monitoring wired (Sentry, inert until `SENTRY_DSN` set, PR #12); cancel-bot #6 code portion (no-fabricated-escalation prompt rule, PR #13); cancel-bot #9 adjacent vuln (email-template reason regexes anchored with word boundaries, PR `fix/template-reason-word-boundaries`).

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
**Status:** FIXED IN CODE 2026-05-12 (PR `fix/sms-resolve-candidate-by-clientId`), pending production verification of the new lookup path
**Severity:** lost outbound volume + misleading skip reasons
**Discovered:** 2026-05-12 (Cowork dig into the funnel from #8)

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
**Status:** AWAITING DECISION (Travis Decisions 1 and 2)
**Severity:** customer-harm, compliance-risk
**Discovered:** April to early May 2026 (660-session review)

Bot pushed retention past clear refusals in multiple sessions:

- Session `d60c370e`: Member said "no I would like to cancel please." Bot offered a 2-month pause. Member said "No thank you, please just cancel." Bot still ran a final-warning loss-framing block before processing.
- Session `9d661a35`: Member said she was moving to Congo. Bot offered four retention options (1-month pause, bi-monthly, consolidate credits to products, final warning) before letting her cancel. Congo doesn't have a Silver Mirror.

Code fix is small (system prompt edit). Business decision is Travis's call: how aggressive should retention be after clear refusals, what's the maximum number of save offers, how is "clear refusal" defined operationally. FTC Negative Option Rule is the legal ceiling.

---

### cancel-bot #6
**Status:** PARTIALLY ADDRESSED - prompt guardrail shipped 2026-05-12 (PR `fix/bot-no-fabricated-escalations`); the broader "what should the bot promise / 48-hour language / sendBeacon robustness" question stays AWAITING DECISION (Travis Decision 3)
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

**Shipped 2026-05-12:** added a `HARD RULE - NO FABRICATED ESCALATION` to `src/lib/system-prompt.txt` forbidding the bot from claiming it has "alerted our QA team," "flagged this as urgent," "escalated to engineering," opened a ticket, or notified any team/queue/system that does not exist; it may say only that it is passing the issue to the memberships team. Test: `__tests__/claude.test.js`. Also confirmed the env audit (memberships email infra IS configured). Still open / Travis Decision 3: whether/how to soften the "48 hours" promise, the `sendBeacon` robustness for leg-A, and any wording changes to the handoff language itself.

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
**Status:** AWAITING DECISION (Travis Decision 4)
**Severity:** trust-risk, unverified data going to members
**Discovered:** Ongoing

Bot quotes specific dollar values for perks:

- "Month 2: Moisturizer ($65 value)"
- "Month 4: Hyaluronic Acid Serum ($77 value)"
- "Month 9: Cleanser ($41 value)"
- "Month 12: Foundational Formulas Bundle ($183 value)"

Nobody has verified whether these are correct, where they came from, or whether they're hard-coded versus model-fabricated. Reviewing Zoe's transcript and others, bot quotes them as authoritative facts.

Three options on the table: verify and lock into single source of truth, drop dollar values entirely, confirm already accurate.

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
**Status:** AWAITING DECISION (Travis Decision 6) - depends on #6 fix
**Severity:** customer-harm in financially sensitive moments
**Discovered:** Ongoing

When member alleges duplicate charges, bot says it sees one membership and asks for screenshots via email. Reads as minimizing for a moment that needs to feel taken seriously. Recommended new script and a real escalation path; depends on cancel-bot #6 fix to know what "escalation path" actually means in code.

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
**Status:** AWAITING DECISION (Travis Decision 9)
**Severity:** customer frustration
**Discovered:** Ongoing

Pattern: Member says she's been trying to cancel via email for six months. Bot suggests calling (888) 677-0055. Member says she's working and can't call. Only then does bot escalate to a human.

Bot keeps deflecting to the phone number when it doesn't know what else to do, even after member said that channel didn't work.

Proposed rule: if member says they've already tried email or phone, the bot should NOT send them back to that channel. Escalate directly.

---

### cancel-bot #17
**Status:** AWAITING DECISION (Travis Decision 10)
**Severity:** member confusion
**Discovered:** Ongoing

Bot says "memberships have no minimum commitment, you can cancel anytime with 30 days notice." Then in the same conversation, it offers a pause with a 3-billing-cycle commitment. Side by side, confusing.

Proposed standardized language pending Travis review.

---

## Cross-cutting issues

### cross-cutting #1
**Status:** BUILT 2026-05-12 (PR #11 `feat/sms-zero-send-alert`, builds on PR #10 `feat/sms-daily-send-counter`)
**Severity:** detection gap that allowed a 3-week prod outage
**Discovered:** May 5, 2026

No health-check alerting on outbound SMS sends. April-May outage went undetected for 3 weeks because the detection mechanism was "Matt happens to check the Sheet."

**Fix:** `src/lib/sms-metrics.js` tracks a daily send count in Redis (`sms-sent:<YYYY-MM-DD>`, 3-day TTL), bumped on every successful Twilio send in `/api/sms/automation/pre-appointment`. A new daily cron `/api/cron/sms-health-check` (`0 14 * * *` ≈ 9-10 AM ET, after the previous day's send window has closed) reads yesterday's count and, if it is below `SMS_MIN_DAILY_SENDS` (default 1), emails `EMAIL_ESCALATION` (fallback `EMAIL_TO`) with a triage checklist. Tests: `__tests__/sms-metrics.test.js`, `__tests__/sms-health-check-route.test.js`. Note: the day right after a deploy may produce one false-positive alert (no counter history yet) - the alert email says so.

---

### cross-cutting #2
**Status:** NOT BUILT
**Severity:** structural test coverage gap
**Outstanding since:** Ongoing

244 Vitest tests exist, but almost all cover email template selection. No integration tests for conversational behavior. "Does the bot honor 'just cancel' after a clear refusal" is the kind of test that would have caught cancel-bot #5 before Emily got hurt.

Test architecture would need to be: simulated conversation replay against the live or fixtured Claude API, scoring on rule violations.

---

### cross-cutting #3
**Status:** PARTIAL (scope-lock rules now exist in PR prompts)
**Severity:** structural risk
**Outstanding since:** Ongoing

Parallel agents (Claude Code, Cursor, Codex) have made uncoordinated changes that broke things. Three of the recent cancel-bot issues trace to template-selection logic refactored without considering all outcome types. The 5-fix bundle on outbound SMS (#7) is the most blatant example.

Mitigations in place: handoff docs, PR scope-lock rules, this `QA_ISSUES.md` file. Durable answer needs a clear "who owns what" map across agents.

---

### cross-cutting #4
**Status:** RECURRING ROOT CAUSE, NOT YET ADDRESSED SYSTEMATICALLY
**Severity:** trust-erosion plus silent prod failures
**Outstanding since:** Ongoing

Multiple integrations silently no-op when env vars are missing instead of failing loudly. This pattern caused cancel-bot #4 (Chatlog Sheet) and is the structural enabler of cancel-bot #6 (fabricated escalation promises).

Fix would be: every integration module asserts required env vars on load, fails the deploy or fails closed if any are missing. Not yet implemented across the codebase.

---

### cross-cutting #5
**Status:** NOT BUILT
**Severity:** quality gate gap
**Outstanding since:** Ongoing

No staging environment. Every change ships to production and gets tested against real guest data. Synthetic appointments and synthetic members would let behavior changes be verified without risk to real sends or real conversations.

---

## Travis decisions ledger

The 10 chatbot-script decisions parked with Travis for review, mirrored from `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`. This list is the authoritative cross-reference between decision number and issue number.

| Decision | Issue | Topic | Stakes |
|---|---|---|---|
| 1 | cancel-bot #5 | Retention aggressiveness after first clear refusal | high (FTC) |
| 2 | cancel-bot #5 | Retention behavior on geographic/medical exits | high |
| 3 | cancel-bot #6 | Escalation reality vs fabricated promises | HIGHEST |
| 4 | cancel-bot #11 | Perk dollar value verification | medium |
| 5 | cancel-bot #12 | Identity verification floor | high (privacy) |
| 6 | cancel-bot #13 | Refund / double-billing escalation script | medium |
| 7 | cancel-bot #14 | Credit visibility approach | medium |
| 8 | cancel-bot #15 | Tone fixes (Perfect!, empathy, benefits list) | low-medium |
| 9 | cancel-bot #16 | Channel-loop rule (don't redirect to failed channels) | medium |
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
