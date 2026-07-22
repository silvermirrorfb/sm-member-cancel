# Silver Mirror Outbound SMS System - What It Does and Every Issue To Date

**Document purpose:** Plain-English explanation of what the outbound SMS system is supposed to do, how it works, and every breakage that's hit it from initial build through May 11, 2026.

**Audience:** Matt, future Claude sessions, and any non-engineer who needs to understand why this keeps breaking.

**Last updated:** May 11, 2026

> **2026-05-12 note:** Some numbers below are stale. The `sms-upgrade-scan` cron now takes `SMS_CRON_BATCH_SIZE` candidates per run, default 30 (not 5), so the "7.5% daily coverage" math here is out of date. The cron response is `summary: { total, sent, skipped, errors }` plus a per-candidate `results[]` array - there is no `skippedByReason` histogram (that was the rejected bundle item #2, never merged). For current cron parameters and the PR #3 verification procedure, see the root `CLAUDE.md` ("Outbound SMS pipeline") and `QA_ISSUES.md` (outbound-sms #8). The narrative below is still accurate on history and root causes.

---

## What the outbound SMS system is supposed to do

Silver Mirror has roughly 4,000+ guests across 10 locations in the Boulevard booking system. When a guest has an appointment coming up in the next 24 hours, the bot is supposed to text them a personalized offer for either:

1. **An add-on** to enhance their facial (peel, serum, eye treatment, etc.)
2. **A duration upgrade** (30-minute to 50-minute, or 50-minute to 90-minute)

The text goes out from `+18885127546` and looks something like:

> Hi [Name], you're booked at Silver Mirror Brickell tomorrow at 2pm. Want to add an Antioxidant Peel for $50? Reply YES to add it, or just enjoy your facial as-is.

The business logic, in plain English:

1. Find every guest with an appointment booked in the next 24 hours
2. For each guest, check if there's a fit (right service, right time gap before/after, right skin profile)
3. Pick a relevant add-on or upgrade
4. Send the SMS via Twilio
5. Track replies and forward YES responses to the front desk to actually add the service to the appointment

That's the core revenue play. It's supposed to capture upsell revenue that gets missed when estheticians don't have time to upsell in person, or when guests don't know what's available.

---

## Where this fits in the bigger picture

The outbound SMS system is one of six SMS workloads running on the same Twilio number (+18885127546):

1. Cancellation chatbot (web widget for member cancellations) - **WORKING**
2. **Pre-appointment add-on upsells - THIS DOCUMENT**
3. **Pre-appointment duration upgrades - THIS DOCUMENT**
4. YES/NO appointment confirmations (Klaviyo-driven) - working
5. 1-hour appointment reminders - working
6. Missed-call autotext (in pilot build for Brickell) - not yet live

When this document talks about "outbound SMS" or "the outage," it means #2 and #3 specifically. The other systems have been fine.

---

## How it actually works (the technical pipeline)

There are two cron jobs that work together:

### Cron 1: Daily Registry Seed (`/api/cron/sms-registry-seed`)
- Runs at 6 AM ET every day
- Pages through Boulevard's `clients` GraphQL API
- Pulls every guest assigned to one of the 10 Silver Mirror locations
- Stores them in Upstash Redis under keys like `sms-registry:loc:{locationId}`
- 7-day TTL on each entry (refreshed daily)
- Current registry size: roughly 4,000 to 4,100 guests across 10 locations

**Why this exists:** Boulevard doesn't have a "find me all appointments at this location" API. Only "find appointments for this specific client." So we have to maintain our own list of all clients per location, then loop through them.

### Cron 2: SMS Upgrade Scan (`/api/cron/sms-upgrade-scan`)
- Runs every 10 minutes during business hours
- Picks a random subset of guests from Redis (Fisher-Yates shuffle, so different guests each run)
- For each guest, calls Boulevard to find upcoming appointments
- If there's a qualifying appointment in the 24-hour window, calls the pre-appointment endpoint
- Pre-appointment endpoint applies all the business rules (fit, gap, skin profile, etc.)
- If passing all rules, sends SMS via Twilio
- Logs the result to a Google Sheet

### The legal gate: Klaviyo SMS consent
Before any text goes out, the system checks Klaviyo to confirm the guest's SMS subscription status is `SUBSCRIBED`. This is the TCPA compliance gate. No subscription, no send. This applies to every guest universally, members and non-members alike. If this check fails, the candidate is skipped and the reason is logged as `klaviyo_sms_not_subscribed`.

**Ratified carve-out (2026-07-22): the applied-outcome follow-up SMS.** Transactional upgrade/add-on confirmation SMS (the deferred follow-up sent after a successful in-place apply, in `src/app/api/sms/twilio/webhook/route.js`) is exempt from the Klaviyo SUBSCRIBED marketing-consent gate, on the same basis as the missed-call auto-text: it is a transactional reply to the member's own YES on their own appointment, not marketing. This carve-out is scoped to this single send. The global STOP-set opt-out is NOT waived and MUST be enforced at send time on this path: the strict tri-state `checkStopSetStrict` check sends only on an affirmative `off`; `on`, `unknown`, or an error withholds the follow-up. Every other outbound SMS/email still requires the standard gate above. Known limitation (recorded 2026-07-22 security review): opt-out propagation into the local STOP set is one-way. A STOP text to the Twilio number feeds the set (and pushes an unsubscribe to Klaviyo), but a consent revocation recorded only in Klaviyo (preference page, list unsubscribe) never lands in the local STOP set, so it is invisible to this send. This is accepted as consistent with the transactional basis of the carve-out: the send is a reply to the member's own YES minutes earlier on the same thread.

---

## The full history of issues, in chronological order

### Issue 1: Boulevard has no "appointments by location" query (architectural discovery)
**When:** Late April 2026, initial build phase
**Severity:** Required full re-architecture

When the system was first being built, the team assumed Boulevard's GraphQL API had a query like "give me all appointments at Bryant Park this week." It doesn't. Boulevard only supports per-client appointment lookups.

**Fix:** Built the Redis-backed daily registry seed as a workaround. The seed loads every client per location into Redis, then the scan cron loops through clients (not appointments) and asks Boulevard for each one's appointments individually. Slower, but functional.

This was not a "bug" - it was a fundamental limitation of the underlying booking platform. The workaround is the daily seed cron described above.

---

### Issue 2: Boulevard API URL bug - `/graphql` appended twice
**When:** Initial build
**Severity:** Hard failure, no requests succeeded

The Boulevard API base URL environment variable was set with `/graphql` already in it, but the code was also appending `/graphql` when making requests. Every request hit a 404.

**Fix:** Removed the appended `/graphql` from the code. The `BOULEVARD_API_URL` env var is now the source of truth and should not be modified.

**Important note for future sessions:** Do NOT suggest changing the Boulevard API URL. It's correctly set. This bug has been resolved and any future "fix" that touches the URL is almost certainly going to break things again.

---

### Issue 3: Vercel function timeouts on Boulevard scans
**When:** Initial build
**Severity:** Crons silently failing

Boulevard's `clients` API is slow. The initial seed cron was trying to page 100 clients at a time and timing out on Vercel's serverless function limit. Same problem on the scan cron when batch sizes were too large.

**Fix:** Reduced batch sizes step by step. Seed cron now pages 20 clients at a time. Scan cron evaluates 5 candidates per run (was originally 50, then 10, then 5). Trade-off: lower throughput.

**Math on current throughput:**
- 5 candidates per run
- 6 runs per hour
- 10 hours of business window per day
- = 300 checks per day, against a registry of ~4,000 guests
- = roughly 7.5% daily coverage of the registry

That coverage rate is the reason guests sometimes don't get a text even though they're eligible. It's working-as-designed given the timeout constraints, but it's not great.

---

### Issue 4: Same guests checked every run (Fisher-Yates fix)
**When:** Initial build
**Severity:** Coverage problem

The first version of the scan cron always pulled the first N entries from Redis, so the same guests were being checked over and over while others were never checked.

**Fix:** Added Fisher-Yates shuffle so every run samples a different random subset of the registry. This doesn't increase coverage but it spreads checks evenly over time.

---

### Issue 5: Klaviyo segment filter was wrong (data quality)
**When:** Pre-outage diagnostic phase, late April 2026
**Severity:** Wasted Boulevard calls, but no actual sends affected

Early code used Klaviyo's compound segment `S3NdQB` as the SMS-subscribed filter. Investigation showed 10 out of 10 sampled members of that segment were actually `NEVER_SUBSCRIBED`. The segment was unreliable.

**Fix:** Switched to checking individual profile subscription status (`SUBSCRIBED` flag) at send time, not at candidate-selection time. Slower but accurate. Legal compliance gate is now bulletproof.

---

### Issue 6: THE BIG ONE - Boulevard appointment query missing client contact info
**When:** April 14 to May 5, 2026 (~3 weeks of outage)
**Severity:** Catastrophic, ZERO outbound SMS sent during this period
**Detection:** Not until Matt manually noticed the SMS log was empty
**Resolution:** PR #3 merged May 5

**What broke:**

In `src/lib/boulevard.js`, the appointment query was using a one-or-the-other pattern to select client info:

```javascript
if (clientIdField) selectedFields.push(clientIdField);
else if (clientObjectField) {  // <-- the bug: "else"
  selectedFields.push(`${clientObjectField} { id firstName lastName email phone ... }`);
}
```

Boulevard's appointment type has BOTH a `clientId` scalar AND a `client` object. Code introspection picked `clientId` first, so it would push the scalar and SKIP the client object. The result: every appointment came back with `clientFirstName`, `clientEmail`, `clientPhone` all null.

The downstream code then filtered out every appointment with null contact info as "incomplete data." So the candidate pool was always empty. Zero candidates → zero sends.

**The fix:** Drop the `else`. Make both selections additive. One word change.

```javascript
if (clientIdField) selectedFields.push(clientIdField);
if (clientObjectField) {  // <-- "if", not "else if"
  selectedFields.push(`${clientObjectField} { id firstName lastName email phone ... }`);
}
```

**Verification before merge:** Cursor was instructed to run a one-off Boulevard query selecting both fields and confirm `client.firstName` came back populated. Live query confirmed both fields return data. Fix shipped via PR #3.

**Process gap surfaced:** This outage went undetected for 3 weeks because there was no alerting on "outbound SMS sends went to zero." A daily health-check cron that pings memberships@silvermirror.com if zero outbound sends in the last 24 hours would have caught this on April 15 instead of May 5. That alerting still hasn't been built.

---

### Issue 7: Five-fix bundle attempted by parallel agent (rejected)
**When:** May 5, 2026, immediately after PR #3 was merged
**Severity:** Did not cause a production issue - caught before commit

Right after PR #3 fixed the outage, Claude Code (running in a parallel session) produced a five-change bundle that it wanted to ship as a single commit:

1. Rewrite the scan cron to use appointment-scanning instead of registry-random
2. Add skip-reason histogram to cron response
3. Add deterministic addon rotation by phone hash
4. Replace in-memory Map cooldown with Redis-backed async cooldown
5. Add member tier resolution via registry fallback

**Why this was rejected:**

- Some of the fixes are legitimately good ideas (#2 telemetry, #5 tier resolution).
- Others are architectural changes that destroy the clean verification signal for PR #3 (#1 cron rewrite would make it impossible to know whether PR #3 alone fixed the outage).
- All five were bundled into one PR, which violates the rule that each architectural change needs its own approval and its own PR.
- This is the second time a parallel agent has tried to ship a multi-fix bundle without coordination.

**Status:** The bundle was stashed in the archive clone (`Code\silvermirrorfb\sm-member-cancel`) and never committed. Each of the five ideas remains available to revisit individually after PR #3 verification is closed out.

---

### Issue 8: Verification of PR #3 has not been completed
**When:** Outstanding as of May 11, 2026
**Severity:** Unknown until verified - could be working, could be broken in a different way

PR #3 was merged on May 5. The verification step was: run `/api/cron/sms-upgrade-scan` and confirm `summary.sent > 0` from a real production cron run.

This verification has been blocked or deferred multiple times. As of May 11, the verification is finally being attempted via Cowork.

**What "verified" looks like:**
- `summary.sent > 0`: outage is over, fix works, system is sending
- `summary.sent = 0` with `summary.skippedByReason` showing real candidates being filtered out for legitimate reasons (Klaviyo, cooldown, send window): fix is working, just no eligible sends in that specific run
- `summary.sent = 0` with errors or empty candidate pool: something else is broken, dig further

---

## Where things stand on May 11, 2026

- PR #3 is merged. The Boulevard appointment query bug is fixed in production.
- Verification of actual sends is in progress via Cowork.
- The five-fix bundle is stashed and uncommitted; revisit individually when ready.
- No alerting exists for "outbound sends went to zero." Should be built. Has not been built.
- Daily registry seed is running and healthy (roughly 4,000 guests).
- Scan cron is running every 10 minutes during business hours.
- Klaviyo consent gate is solid.
- STOP handling, cooldowns, and send-window enforcement are all in place.

---

## Why this has been so frustrating

In plain English, here's why this keeps breaking:

1. **The booking platform (Boulevard) has constraints we have to work around.** No "appointments by location" query, slow API, unintuitive schema with both `clientId` and `client` fields. Every workaround introduces complexity, and complexity introduces bugs.

2. **The fix surface is small but the impact is huge.** The one-word bug in PR #3 took down outbound SMS for three weeks. There's no "graceful degradation" - either the candidate pool is populated or it isn't.

3. **There's no end-to-end monitoring.** When sends go to zero, nobody knows until someone manually checks. The detection mechanism is "Matt happens to look at the Sheet and notice it's empty." That's not a system.

4. **Parallel agents make uncoordinated changes.** Claude Code, Cursor, and Codex have all worked on this codebase. They've shipped fixes that conflict, bundled unrelated changes into single commits, and attempted architectural rewrites without approval. The handoff documents and the strict scope-lock rules in PR prompts exist to defend against this.

5. **The throughput is limited by Vercel timeouts.** Even when everything is working, we only check ~7.5% of the registry per day. Some appointments will slip through without a text, by design.

---

## What would make this better

In rough priority order:

1. **Health-check alerting.** A daily cron that fires an email if outbound sends < N in the last 24 hours. Would have caught the April outage on day 1.

2. **Parallel candidate processing.** The pre-appointment endpoint processes candidates one at a time. Parallelizing them would let us check 50 candidates per run instead of 5, lifting coverage from 7.5% to ~75%.

3. **Better telemetry.** The five-fix bundle item #2 (skip-reason histogram) would make it dramatically easier to see why sends aren't happening on any given run. Worth shipping as its own small PR.

4. **A real candidate-deduplication strategy.** Right now if the same guest is randomly sampled twice in 24 hours, they only avoid a duplicate text because of the cooldown logic. A pre-filter against "already sent today" would save Boulevard API calls.

5. **A test environment.** Right now every change ships to production and gets tested against real guest data. A staging environment with synthetic appointments would let us verify behavior changes without risking real sends.

---

## What sends look like when working

A healthy `/api/cron/sms-upgrade-scan` response looks like this:

```json
{
  "summary": {
    "candidates": 5,
    "sent": 2,
    "skipped": 3,
    "skippedByReason": {
      "no_upcoming_appointment": 2,
      "klaviyo_sms_not_subscribed": 1
    },
    "errors": 0
  },
  "results": [...]
}
```

That's saying: out of 5 randomly sampled guests, 2 had qualifying appointments AND were Klaviyo SMS subscribers, so they got texts. The other 3 were skipped (2 had no upcoming appointment, 1 wasn't SMS-subscribed). Zero errors. This is what a normal healthy run should look like.

If `sent` is 0 across many runs in a row AND `skippedByReason` doesn't show meaningful filtering, that's a problem. That's what the April-May outage looked like: all 5 candidates skipped every run because their contact info was null.
