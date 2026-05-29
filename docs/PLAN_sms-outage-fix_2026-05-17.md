# SMS Outbound Outage Fix Plan

**Date:** 2026-05-17
**Author:** Claude Code (gstack /investigate + /codex consult + /superpowers:writing-plans)
**Status:** READY FOR EXECUTION

> **One-line ship summary:** Ship PR1 (transport) first because every 10-minute cron tick that passes is another batch of appointment upsells that members never receive. PR2 (observability) ships within 24 hours after PR1 verifies green, so the next outage of this class triggers same-day alerts instead of hiding for five days again.

---

## Goal

End the 5-day outbound SMS outage (zero sends since May 12 commit `73e2fce`) and remove the silent-failure pattern that hid it. Restore daily SMS volume to pre-outage baseline (last confirmed 3 real sends on May 12). After fix verification, the daily zero-send health-check alert should stop firing.

## Architecture

The cron at `src/app/api/cron/sms-upgrade-scan/route.js` discovers appointment candidates every 10 minutes and dispatches HTTP POST self-fetches to `/api/sms/automation/pre-appointment` to evaluate and send. Two defects compound: the self-fetch URL resolves to a Vercel-edge-protected host (HTTP 401 SSO challenge before the function runs), and the response handler swallows that failure into a benign-looking "unknown skip" bucket so monitoring saw nothing wrong.

## Tech Stack

- Next.js 14 App Router on Vercel (Node.js runtime, region iad1)
- Upstash Redis for daily send counter and rate-limit dedupe
- Twilio for SMS send (number `+18885127546`)
- Klaviyo for TCPA consent gate (DO NOT TOUCH)
- Boulevard GraphQL for appointment discovery
- Vitest for tests (244 currently passing)

---

## Decision log

### Decision 1: Two sequential PRs, not bundled

CLAUDE.md hard rule: "One fix per PR. If a PR description contains the word 'and' between two architectural changes, split it." This is two distinct defects in two distinct concerns (transport vs observability). Bundling violates the rule and makes rollback harder.

PR1 first because it stops the active outage. PR2 second because it prevents the next one from hiding.

### Decision 2: Transport fix uses a stable base URL via env var with hardcoded production-alias fallback

Picked: env var `SMS_AUTOMATION_BASE_URL` with fallback to the literal string `https://sm-member-cancel.vercel.app`.

Rejected alternatives:
- **Vercel protection-bypass token**: requires Vercel UI configuration + ongoing token rotation discipline. More moving parts for no extra durability.
- **Eliminate self-fetch (in-process invocation)**: correct long-term but ~50 line refactor with risk of behavioral surprises in Klaviyo/Boulevard/Twilio integration code paths. Bad call under outage pressure.

Why this choice:
- Blast radius: 3 lines in cron route + 1 line in `.env.example`. Tests trivially mockable.
- Durability: `sm-member-cancel.vercel.app` is the project's auto-managed default alias. Won't change unless the project is renamed.
- Time to restore: ~10 minutes from commit to first verified send.
- Reversibility: `git revert <sha>` restores original behavior. Env var can be unset without redeploy.
- Safety: hardcoded fallback means the system works even if env var is missing. The env var exists as a future-proofing override (e.g., if Matt adds a custom domain later).

### Decision 3: Observability fix surfaces HTTP failures as errors AND adds inline same-cron-tick alert

Picked: fix `checkOneCandidate` to check `res.ok` and JSON-parse-success, route HTTP failures into the existing `errors` bucket with `http_<status>` reasons, add a `httpStatusCodes` histogram to the summary, AND add an immediate ops email alert (with 1-hour Redis dedupe) when a single cron run shows `sent===0 && errors>0`.

The daily zero-send alert cron at `src/app/api/cron/sms-health-check/route.js` stays untouched. It's correct. The masking chain just denied it usable signal. Once `summary.errors > 0` surfaces in real time and triggers an inline email, the daily alert becomes a backstop, not the primary signal.

---

## File Structure

### PR1 (Transport)

| File | Change type | What |
|------|-------------|------|
| `src/app/api/cron/sms-upgrade-scan/route.js` | Modify | Replace `request.url`-based URL construction with env-var-with-fallback |
| `__tests__/sms-upgrade-scan-route.test.js` | Modify | Add 2 tests: env var override path, hardcoded fallback path |
| `.env.example` | Modify | Document `SMS_AUTOMATION_BASE_URL` |
| `QA_ISSUES.md` | Modify | Add outbound-sms #10 entry, mark IN PROGRESS then FIXED after verify |
| Vercel env (production) | External | Add `SMS_AUTOMATION_BASE_URL=https://sm-member-cancel.vercel.app` |

### PR2 (Observability)

| File | Change type | What |
|------|-------------|------|
| `src/app/api/cron/sms-upgrade-scan/route.js` | Modify | Rewrite `checkOneCandidate` to check `res.ok`; extend summary with `httpStatusCodes`; add post-summary inline alert |
| `__tests__/sms-upgrade-scan-route.test.js` | Modify | Add 4 tests: 401 → error bucket, 500 → error bucket, JSON parse fail → error bucket, inline alert fires once per hour |
| `QA_ISSUES.md` | Modify | Add cross-cutting #2 entry for observability defect, mark FIXED after verify |

---

## PR1 — Transport fix

### Scope

ONE concern: change how `sms-upgrade-scan` builds the fetch URL so it hits the unprotected project alias instead of the protected deployment-specific URL.

### Files to touch

- `src/app/api/cron/sms-upgrade-scan/route.js` (lines 205-207)
- `__tests__/sms-upgrade-scan-route.test.js` (add 2 test cases)
- `.env.example` (add new env var documentation)
- `QA_ISSUES.md` (add issue entry)

### Files NOT to touch

- `src/app/api/sms/automation/pre-appointment/route.js` (downstream, no change needed)
- `src/lib/sms-metrics.js`, `src/lib/klaviyo.js`, `src/lib/twilio.js`, `src/lib/boulevard.js`
- `src/app/api/cron/sms-health-check/route.js` (daily alert, untouched)
- `src/app/api/cron/sms-registry-seed/route.js`, `src/app/api/cron/missed-call-dispatch-drain/route.js`
- `system-prompt.txt`, any cancel-bot logic
- `vercel.json` (cron schedule unchanged)

### Exact code change

Locate in `src/app/api/cron/sms-upgrade-scan/route.js` near line 205:

```js
// BEFORE (line 205):
  const endpoint = new URL('/api/sms/automation/pre-appointment', request.url);
```

Replace with:

```js
// AFTER:
  const automationBaseUrl = String(
    process.env.SMS_AUTOMATION_BASE_URL || 'https://sm-member-cancel.vercel.app',
  ).trim();
  const endpoint = new URL('/api/sms/automation/pre-appointment', automationBaseUrl);
```

That is the entire production code change. Three lines added, one line modified. No other lines in the file touched.

### Test additions

In `__tests__/sms-upgrade-scan-route.test.js`, add two test cases inside the existing describe block. Use the existing mocking patterns from the file (do not introduce new mocking libraries).

```js
it('uses SMS_AUTOMATION_BASE_URL when set', async () => {
  process.env.SMS_AUTOMATION_BASE_URL = 'https://override.example.com';
  // ... existing setup that triggers the cron's candidate-discovery branch ...
  // assert that mocked fetch was called with a URL starting with 'https://override.example.com/api/sms/automation/pre-appointment'
});

it('falls back to sm-member-cancel.vercel.app when SMS_AUTOMATION_BASE_URL is unset', async () => {
  delete process.env.SMS_AUTOMATION_BASE_URL;
  // ... existing setup ...
  // assert that mocked fetch was called with 'https://sm-member-cancel.vercel.app/api/sms/automation/pre-appointment'
});
```

The existing test file at `__tests__/sms-upgrade-scan-route.test.js` already has the setup pattern for the discovery branch (5 cases per the May 12 commit message). Mirror those patterns.

### `.env.example` addition

Add this section to `.env.example` near the other `SMS_CRON_*` variables:

```
# Base URL for the cron's self-fetch to /api/sms/automation/pre-appointment.
# Must be a Vercel domain that is NOT behind deployment protection (SSO).
# Default fallback is the project's stable alias.
SMS_AUTOMATION_BASE_URL=https://sm-member-cancel.vercel.app
```

### `QA_ISSUES.md` entry

Add to the outbound-sms section (find the existing `#9 VERIFIED FIXED` entry and add `#10` after it):

```
### outbound-sms #10: cron self-fetch blocked by Vercel Deployment Protection (FIXED 2026-05-17)

**Symptom:** Zero outbound SMS sends since May 12. Cron summary log showed
skippedByReason: {unknown: N} every run, summary.errors: 0, daily zero-send
alert eventually fired on May 17.

**Root cause:** The cron in src/app/api/cron/sms-upgrade-scan/route.js:205
constructed the self-fetch endpoint using request.url, which resolves to the
deployment-specific URL (sm-member-cancel-<hash>-silver-mirror-projects.vercel.app).
That hostname has Vercel Deployment Protection enabled and returns HTTP 401 +
an HTML SSO challenge page before the function runs. The cron's response handler
swallowed the HTML into {} and classified each candidate as an "unknown" skip,
not an error.

**Introduced by:** commit 73e2fce on 2026-05-12 (per-location appointment
discovery rewrite that replaced the random-registry-sampling code path with an
HTTP self-fetch).

**Fix:** PR #<N> changed the endpoint base URL to a hardcoded fallback of
https://sm-member-cancel.vercel.app with an override via SMS_AUTOMATION_BASE_URL
env var. The project alias is not behind deployment protection (curl returns
405 with x-matched-path header, proving the route is reachable).

**Verification:** see PR description for binary pass/fail check.
```

### Implementation steps

- [ ] **Step 1:** Branch from main

```bash
cd ~/sm-member-cancel
git fetch origin
git checkout main
git pull origin main
git checkout -b fix/sms-cron-transport-vercel-protection
```

- [ ] **Step 2:** Run the existing test suite to establish baseline green

```bash
npm test -- __tests__/sms-upgrade-scan-route.test.js
```

Expected: all 5 cases pass.
[PASS] criteria: exit code 0, "Tests passed" message.
[FAIL] criteria: any failure. STOP and report before continuing.

- [ ] **Step 3:** Write the two new failing tests in `__tests__/sms-upgrade-scan-route.test.js`

Add the two test cases shown in "Test additions" above. Use exact mocking patterns from existing cases in the file.

- [ ] **Step 4:** Run the test file and verify the two new tests FAIL

```bash
npm test -- __tests__/sms-upgrade-scan-route.test.js
```

Expected: 5 pass, 2 fail. The failures should mention the wrong URL being passed to fetch.
[PASS] criteria: tests fail with URL assertion mismatch (proves tests are meaningful).
[FAIL] criteria: tests pass without code changes (means tests are not actually checking the URL).

- [ ] **Step 5:** Apply the code change in `src/app/api/cron/sms-upgrade-scan/route.js`

Make the exact change shown in "Exact code change" above.

- [ ] **Step 6:** Re-run the test file, verify all 7 tests pass

```bash
npm test -- __tests__/sms-upgrade-scan-route.test.js
```

[PASS] criteria: all 7 tests pass.
[FAIL] criteria: any failure. Inspect, fix, re-run.

- [ ] **Step 7:** Run the full test suite to confirm no regressions

```bash
npm test
```

[PASS] criteria: 244 + 2 = 246 tests pass, 0 fail.
[FAIL] criteria: any pre-existing test fails. STOP, do not commit.

- [ ] **Step 8:** Update `.env.example`

Add the documentation block shown in `.env.example` addition above.

- [ ] **Step 9:** Update `QA_ISSUES.md`

Add the entry shown in `QA_ISSUES.md` entry above. Status: IN PROGRESS. Will be flipped to FIXED after verification.

- [ ] **Step 10:** Commit

```bash
git add src/app/api/cron/sms-upgrade-scan/route.js \
        __tests__/sms-upgrade-scan-route.test.js \
        .env.example \
        QA_ISSUES.md
git commit -m "$(cat <<'EOF'
fix(sms): route cron self-fetch through unprotected alias

The sms-upgrade-scan cron built its pre-appointment fetch URL from
request.url, which resolves to the deployment-specific hostname
(sm-member-cancel-<hash>-silver-mirror-projects.vercel.app). That host
has Vercel Deployment Protection enabled, so every self-fetch returned
HTTP 401 with an HTML SSO challenge before the function ran. The cron
silently bucketed those failures as "unknown" skips, producing the
zero-send outage that ran from May 12 to May 17.

The fix routes the fetch through https://sm-member-cancel.vercel.app
(the project's stable alias, which is not protected). The base URL is
overridable via SMS_AUTOMATION_BASE_URL for future flexibility.

Verified by curl before commit: the deployment URL returns 401 with a
_vercel_sso_nonce cookie; the alias returns 405 with x-matched-path
proving the route is reachable.

Tests added in __tests__/sms-upgrade-scan-route.test.js cover both the
env-var override and the hardcoded fallback. Full suite green
(246 tests).

QA_ISSUES.md: outbound-sms #10 opened.
EOF
)"
```

- [ ] **Step 11:** Set the Vercel env var in production

```bash
echo "https://sm-member-cancel.vercel.app" | vercel env add SMS_AUTOMATION_BASE_URL production
```

If the env var already exists, use `vercel env rm SMS_AUTOMATION_BASE_URL production` first, then add.

[PASS] criteria: `vercel env ls production | grep SMS_AUTOMATION_BASE_URL` shows the variable present.

- [ ] **Step 12:** Push and open PR

```bash
git push -u origin fix/sms-cron-transport-vercel-protection
gh pr create --title "fix(sms): route cron self-fetch through unprotected alias" --body "$(cat <<'EOF'
## What

Fixes the 5-day outbound SMS outage that started May 12 (commit 73e2fce).

The `sms-upgrade-scan` cron at `src/app/api/cron/sms-upgrade-scan/route.js:205` built its self-fetch URL from `request.url`, which on Vercel cron invocations resolves to the deployment-specific hostname. That hostname is behind Vercel Deployment Protection (SSO), so every self-fetch returned an HTML 401 challenge page instead of reaching the function. The cron's response handler swallowed the HTML into `{}` and silently bucketed each candidate as an "unknown" skip.

This PR changes the base URL to `https://sm-member-cancel.vercel.app` (the project's stable alias, not protected). Overridable via `SMS_AUTOMATION_BASE_URL` env var.

## Why this approach

Three options were considered:
1. Stable alias via env var (this PR): 3 lines, 10 minute restore, trivially reversible
2. Vercel protection-bypass token: ongoing token management for marginal benefit
3. Refactor to in-process invocation: 50 line refactor, riskier under outage pressure

Picked #1. Option #3 may be revisited later as a separate refactor PR.

## Test plan

- [ ] After deploy, wait for next 10-minute cron tick
- [ ] Confirm Vercel runtime logs show new POST entries for `/api/sms/automation/pre-appointment`
- [ ] Run `node scripts/diag-sms-daily-counts.mjs` and confirm today's `sms-sent:` Redis key materializes (non-zero count)
- [ ] Confirm next cron summary log shows `summary.sent > 0` OR `summary.skippedByReason` contains real reasons like `klaviyo_sms_not_subscribed` (not `unknown`)
- [ ] Daily zero-send health-check email should stop firing tomorrow morning (May 18 14:00 UTC)

## QA_ISSUES

outbound-sms #10 (this fix)
EOF
)"
```

### Verification after deploy

Vercel auto-deploys on push to main (30 second deploy cycle per CLAUDE.md). After the PR merges:

- [ ] **Step V1:** Wait 11 minutes for the next cron tick

- [ ] **Step V2:** Pull production env to confirm var is set

```bash
cd ~/sm-member-cancel
vercel env ls production | grep SMS_AUTOMATION_BASE_URL
```

[PASS] criteria: line shows `SMS_AUTOMATION_BASE_URL Encrypted Production`.
[FAIL] criteria: variable missing. Re-run step 11.

- [ ] **Step V3:** Check Vercel runtime logs for a fresh pre-appointment invocation

Use the Vercel MCP `get_runtime_logs` tool, or run:

```bash
vercel logs https://sm-member-cancel.vercel.app --since=15m 2>&1 | grep "/api/sms/automation/pre-appointment"
```

[PASS] criteria: one or more lines showing `POST /api/sms/automation/pre-appointment 200` (or 4xx/5xx, but presence of the path proves the route is now invoked).
[FAIL] criteria: zero matching lines after 11+ minutes. Hypothesis is wrong, escalate.

- [ ] **Step V4:** Confirm new Redis send counter

```bash
node scripts/diag-sms-daily-counts.mjs
```

[PASS] criteria: line `2026-05-17: N` where N >= 1, OR `2026-05-18: N` if past midnight ET.
[FAIL] criteria: still `missing` after 30 minutes. Sends are not actually completing. Check Vercel logs for skip reasons (likely `klaviyo_sms_not_subscribed` for that batch, which is correct behavior but not a "sent" signal). Re-run after multiple cron ticks.

- [ ] **Step V5:** Flip QA_ISSUES.md entry to FIXED

```bash
# Update outbound-sms #10 status header from "IN PROGRESS" to "VERIFIED FIXED 2026-05-17"
# Commit and push
git checkout main && git pull
# Edit QA_ISSUES.md
git add QA_ISSUES.md
git commit -m "docs(QA_ISSUES): outbound-sms #10 VERIFIED FIXED -- self-fetch reaches function via unprotected alias"
git push origin main
```

### Rollback for PR1

If verification fails or sends do not resume:

```bash
# Find the PR1 merge commit
git log --oneline -5
# Revert it
git revert <merge-sha>
git push origin main
# Optionally also remove the env var
vercel env rm SMS_AUTOMATION_BASE_URL production
```

The system returns to the broken-but-known May 12 state. No data loss, no member impact beyond continued outage.

---

## PR2 — Observability fix

### Scope

ONE concern: make the cron surface real HTTP-layer failures as errors instead of silent "unknown" skips, and fire an immediate ops email when a single cron run shows zero sends with any errors.

### Files to touch

- `src/app/api/cron/sms-upgrade-scan/route.js` (rewrite `checkOneCandidate` at lines 113-145; extend summary at lines 227-247; add post-summary inline alert)
- `__tests__/sms-upgrade-scan-route.test.js` (add 4 test cases)
- `QA_ISSUES.md` (add cross-cutting #2 entry)

### Files NOT to touch

- `src/app/api/sms/automation/pre-appointment/route.js` (downstream, no change)
- `src/lib/sms-metrics.js` (current Redis send counter is correct)
- `src/lib/klaviyo.js`, `src/lib/twilio.js`, `src/lib/boulevard.js`
- `src/app/api/cron/sms-health-check/route.js` (daily alert untouched, becomes the backstop)
- `src/lib/notify.js` (reuse existing `sendOpsAlertEmail` import, do not modify)

### Exact code change

**Change 1: rewrite `checkOneCandidate`** in `src/app/api/cron/sms-upgrade-scan/route.js` (lines 113-145):

```js
// BEFORE (lines 113-145):
function checkOneCandidate(candidate, endpoint, automationToken, now) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(automationToken ? { 'x-automation-token': automationToken } : {}),
    },
    body: JSON.stringify({
      dryRun: false,
      windowHours: DISCOVERY_WINDOW_HOURS,
      candidates: [candidate],
      trigger: 'vercel-cron-sms-upgrade-scan',
      now,
    }),
    cache: 'no-store',
  })
    .then(res => res.json().catch(() => ({})))
    .then(payload => {
      const r = payload?.results?.[0] || {};
      return {
        candidate: `${candidate.firstName} ${candidate.lastName}`.trim(),
        status: r.status || 'unknown',
        reason: r.reason || r.offerKind || null,
        ok: true,
      };
    })
    .catch(err => ({
      candidate: `${candidate.firstName} ${candidate.lastName}`.trim(),
      status: 'error',
      reason: err.message,
      ok: false,
    }));
}
```

Replace with:

```js
// AFTER (lines 113-145 replacement):
async function checkOneCandidate(candidate, endpoint, automationToken, now) {
  const candidateName = `${candidate.firstName} ${candidate.lastName}`.trim();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(automationToken ? { 'x-automation-token': automationToken } : {}),
      },
      body: JSON.stringify({
        dryRun: false,
        windowHours: DISCOVERY_WINDOW_HOURS,
        candidates: [candidate],
        trigger: 'vercel-cron-sms-upgrade-scan',
        now,
      }),
      cache: 'no-store',
    });
    if (!res.ok) {
      return {
        candidate: candidateName,
        status: 'error',
        reason: `http_${res.status}`,
        httpStatus: res.status,
        ok: false,
      };
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (parseErr) {
      return {
        candidate: candidateName,
        status: 'error',
        reason: 'non_json_response',
        httpStatus: res.status,
        ok: false,
      };
    }
    const r = payload?.results?.[0] || {};
    return {
      candidate: candidateName,
      status: r.status || 'unknown',
      reason: r.reason || r.offerKind || null,
      httpStatus: res.status,
      ok: true,
    };
  } catch (err) {
    return {
      candidate: candidateName,
      status: 'error',
      reason: err?.message || 'fetch_failed',
      httpStatus: null,
      ok: false,
    };
  }
}
```

**Change 2: extend summary with httpStatusCodes histogram and post-summary alert** at lines 227-247:

```js
// BEFORE (lines 227-247):
  const summary = { total: allResults.length, sent: 0, skipped: 0, errors: 0, skippedByReason: {} };
  for (const val of allResults) {
    if (val.status === 'sent') summary.sent++;
    else if (val.status === 'error' || !val.ok) summary.errors++;
    else {
      summary.skipped++;
      const reason = val.reason || 'unknown';
      summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
    }
  }

  const payload = {
    ok: true,
    runLocations: runLocationIds,
    registryCounts,
    candidateCount: candidates.length,
    summary,
    results: allResults,
  };
  console.log('[sms-upgrade-scan]', JSON.stringify({ runLocations: runLocationIds, candidateCount: candidates.length, summary }));
  return NextResponse.json(payload);
}
```

Replace with:

```js
// AFTER (lines 227-247 replacement):
  const summary = {
    total: allResults.length,
    sent: 0,
    skipped: 0,
    errors: 0,
    skippedByReason: {},
    errorsByReason: {},
    httpStatusCodes: {},
  };
  for (const val of allResults) {
    if (val.httpStatus != null) {
      const code = String(val.httpStatus);
      summary.httpStatusCodes[code] = (summary.httpStatusCodes[code] || 0) + 1;
    }
    if (val.status === 'sent') summary.sent++;
    else if (val.status === 'error' || !val.ok) {
      summary.errors++;
      const reason = val.reason || 'unknown';
      summary.errorsByReason[reason] = (summary.errorsByReason[reason] || 0) + 1;
    } else {
      summary.skipped++;
      const reason = val.reason || 'unknown';
      summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
    }
  }

  const payload = {
    ok: true,
    runLocations: runLocationIds,
    registryCounts,
    candidateCount: candidates.length,
    summary,
    results: allResults,
  };
  const summaryLogPayload = { runLocations: runLocationIds, candidateCount: candidates.length, summary };
  if (summary.errors > 0) {
    console.error('[sms-upgrade-scan]', JSON.stringify(summaryLogPayload));
  } else {
    console.log('[sms-upgrade-scan]', JSON.stringify(summaryLogPayload));
  }
  if (summary.sent === 0 && summary.errors > 0) {
    await maybeAlertInlineFailure(summary).catch(err => {
      console.error('[sms-upgrade-scan] inline alert failed:', err?.message || err);
    });
  }
  return NextResponse.json(payload);
}
```

**Change 3: add the inline-alert helper and the notify import.** At the top of the file (after the existing imports near lines 4-11), add:

```js
import { sendOpsAlertEmail } from '../../../../lib/notify';
import { Redis } from '@upstash/redis';
```

If `@upstash/redis` is not already imported in the file, add it. If it is, do not duplicate.

Then add this helper function near the other top-level helpers (e.g., right after `pickRunLocationIds` at line 57):

```js
let cachedAlertRedis = null;
function getAlertRedis() {
  if (cachedAlertRedis) return cachedAlertRedis;
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  cachedAlertRedis = new Redis({ url, token });
  return cachedAlertRedis;
}

async function maybeAlertInlineFailure(summary) {
  const redis = getAlertRedis();
  const hourBucket = new Date().toISOString().slice(0, 13);
  const alertKey = `sms-error-alert:${hourBucket}`;
  if (redis) {
    const set = await redis.set(alertKey, '1', { nx: true, ex: 3600 });
    if (!set) return false;
  }
  const subject = `[Silver Mirror] SMS cron showing HTTP errors with zero sends`;
  const text = [
    `The sms-upgrade-scan cron just completed a run with summary.sent=0 and summary.errors=${summary.errors}.`,
    '',
    `Total candidates: ${summary.total}`,
    `Sent: ${summary.sent}`,
    `Skipped: ${summary.skipped}`,
    `Errors: ${summary.errors}`,
    `errorsByReason: ${JSON.stringify(summary.errorsByReason || {})}`,
    `skippedByReason: ${JSON.stringify(summary.skippedByReason || {})}`,
    `httpStatusCodes: ${JSON.stringify(summary.httpStatusCodes || {})}`,
    '',
    'This alert is rate-limited to once per hour. Check Vercel logs for [sms-upgrade-scan] entries at error level.',
    '',
    'See docs/outbound-sms-system-and-issues.md and QA_ISSUES.md (outbound-sms section).',
  ].join('\n');
  const result = await sendOpsAlertEmail({ subject, text });
  return result?.sent === true;
}
```

### Test additions

In `__tests__/sms-upgrade-scan-route.test.js`, add four new test cases:

```js
it('buckets HTTP 401 response as error with reason http_401', async () => {
  // mock fetch to resolve to { ok: false, status: 401, json: () => Promise.resolve({}) }
  // assert summary.errors === N where N === candidates dispatched
  // assert summary.errorsByReason.http_401 === N
  // assert summary.httpStatusCodes['401'] === N
  // assert summary.sent === 0
});

it('buckets HTTP 500 response as error with reason http_500', async () => {
  // mock fetch to resolve to { ok: false, status: 500, json: () => Promise.resolve({}) }
  // assert summary.errors > 0
  // assert summary.errorsByReason.http_500 > 0
});

it('buckets non-JSON response as error with reason non_json_response', async () => {
  // mock fetch to resolve to { ok: true, status: 200, json: () => Promise.reject(new Error('Unexpected token <')) }
  // assert summary.errorsByReason.non_json_response > 0
});

it('fires inline alert once per hour when sent=0 and errors>0', async () => {
  // mock fetch as in the 401 test
  // mock sendOpsAlertEmail to track calls
  // mock Redis to track sms-error-alert:* SET NX EX calls (first returns 'OK', subsequent return null)
  // call the cron twice in succession
  // assert sendOpsAlertEmail was called exactly once
});
```

### `QA_ISSUES.md` entry

Add to the cross-cutting section (find the existing `#1` entry from the May 12 outage memory and add `#2` after it):

```
### cross-cutting #2: sms-upgrade-scan masking chain hid the outage for 5 days (FIXED 2026-05-17)

**Symptom:** Outbound SMS outage that started May 12 (outbound-sms #10) ran
undetected until May 17 when the daily zero-send alert finally fired.

**Root cause:** checkOneCandidate in sms-upgrade-scan/route.js had four
compounding observability defects:
1. res.json().catch(() => ({})) swallowed HTML responses into {}
2. No res.ok check, so 401/403/500 were treated identically to 200
3. ok: true was hardcoded in the .then arm regardless of HTTP status
4. The summary builder bucketed candidates with no recognized reason into
   skippedByReason["unknown"] (a skip), not as errors

Result: summary.errors stayed at 0 throughout the outage. Vercel runtime logs
showed every cron run as "ok" with skippedByReason: {unknown: N}. The daily
zero-send alert was the only structural signal, and it took 5 days to fire.

**Fix:** PR #<M> rewrote checkOneCandidate to check res.ok before parsing,
route HTTP failures into the errors bucket with reason http_<status>, return
errors for JSON parse failures with reason non_json_response, added a
httpStatusCodes histogram to the summary, elevated the summary log to
console.error when errors > 0, and added an inline ops email alert (rate-
limited to once per hour via Redis SET NX) when a single cron run shows
sent=0 and errors>0.

The daily zero-send alert cron at sms-health-check is intentionally untouched.
It is correct. After this fix it becomes the backstop, not the primary signal.

**Verification:** see PR description for failure-injection test.
```

### Implementation steps

- [ ] **Step 1:** Branch from main (post-PR1 merge)

```bash
cd ~/sm-member-cancel
git fetch origin
git checkout main
git pull origin main
git checkout -b fix/sms-cron-observability-masking
```

- [ ] **Step 2:** Baseline tests

```bash
npm test -- __tests__/sms-upgrade-scan-route.test.js
```

[PASS] criteria: all 7 tests pass (5 original + 2 from PR1).
[FAIL] criteria: any failure. STOP.

- [ ] **Step 3:** Write the 4 new failing tests

Add the four test cases shown in "Test additions" above. Use existing mock patterns from the file. For the inline-alert test, mock both `sendOpsAlertEmail` (imported from `src/lib/notify`) and the Redis client.

- [ ] **Step 4:** Run the test file, verify the 4 new tests FAIL

```bash
npm test -- __tests__/sms-upgrade-scan-route.test.js
```

[PASS] criteria: 7 pass, 4 fail. Failures should reference missing httpStatusCodes / errorsByReason fields or wrong bucketing.
[FAIL] criteria: tests pass without code changes. Tests are not meaningful.

- [ ] **Step 5:** Apply Change 1 (rewrite checkOneCandidate)

Replace lines 113-145 with the new async version shown above.

- [ ] **Step 6:** Apply Change 2 (summary + post-summary alert)

Replace lines 227-247 with the new version shown above.

- [ ] **Step 7:** Apply Change 3 (imports + helper)

Add imports at top of file. Add `maybeAlertInlineFailure` and `getAlertRedis` helpers after `pickRunLocationIds`.

- [ ] **Step 8:** Re-run the test file, verify all 11 tests pass

```bash
npm test -- __tests__/sms-upgrade-scan-route.test.js
```

[PASS] criteria: all 11 tests pass.
[FAIL] criteria: inspect, fix, re-run.

- [ ] **Step 9:** Full test suite

```bash
npm test
```

[PASS] criteria: 244 + 2 + 4 = 250 tests pass, 0 fail.
[FAIL] criteria: any pre-existing test fails. STOP.

- [ ] **Step 10:** Update QA_ISSUES.md

Add the cross-cutting #2 entry. Status: IN PROGRESS. Will be flipped to FIXED after verification.

- [ ] **Step 11:** Commit

```bash
git add src/app/api/cron/sms-upgrade-scan/route.js \
        __tests__/sms-upgrade-scan-route.test.js \
        QA_ISSUES.md
git commit -m "$(cat <<'EOF'
fix(sms): surface HTTP failures and alert on zero-send-with-errors runs

checkOneCandidate previously swallowed all HTTP failures from the
pre-appointment self-fetch into a benign "unknown skip" bucket. A 401
SSO challenge or a 500 stack trace looked identical to a Klaviyo
opt-out skip in summary.skippedByReason. The May 12 to May 17 outage
ran for 5 days with summary.errors at 0 the entire time.

This commit:
- Checks res.ok before parsing the response body and routes HTTP
  failures into summary.errors with reason http_<status>.
- Returns an error with reason non_json_response when the body is
  unparseable (e.g., HTML SSO challenge pages).
- Adds a httpStatusCodes histogram to the summary so the distribution
  is visible in Vercel runtime logs.
- Elevates the summary log to console.error when errors > 0 so Vercel
  log filters surface it at warning level.
- Fires an inline ops email alert (rate-limited to once per hour via
  Redis SET NX) when a single cron run shows sent=0 and errors>0.

The daily zero-send alert cron at sms-health-check is intentionally
untouched. It becomes the backstop after this fix, not the primary
signal.

Tests added in __tests__/sms-upgrade-scan-route.test.js cover the
HTTP 401, HTTP 500, non-JSON, and once-per-hour-alert paths. Full
suite green (250 tests).

QA_ISSUES.md: cross-cutting #2 opened.
EOF
)"
```

- [ ] **Step 12:** Push and open PR

```bash
git push -u origin fix/sms-cron-observability-masking
gh pr create --title "fix(sms): surface HTTP failures and alert on zero-send-with-errors runs" --body "$(cat <<'EOF'
## What

Removes the 4-link masking chain in `checkOneCandidate` that hid the May 12 to May 17 outage. After this PR, any future outage of that class produces `summary.errors > 0` in the next cron summary log AND triggers an immediate ops email (rate-limited to once per hour).

## Why

The cron's response handler treated HTTP 401, 500, and non-JSON bodies identically to a benign "Klaviyo opt-out" skip. `summary.errors` stayed at 0 throughout the outage. The only signal was the daily zero-send alert, which took 5 days to fire because the Redis TTL on the last May 12 success counter had to expire first.

## Changes

- `checkOneCandidate`: now checks `res.ok` before parsing, routes HTTP failures into `summary.errors` with reason `http_<status>`, handles non-JSON responses with reason `non_json_response`.
- Summary: adds `httpStatusCodes` histogram and `errorsByReason` breakdown for visibility.
- Summary log: elevated to `console.error` when errors > 0 (Vercel log filters can surface it at warning level).
- New helper `maybeAlertInlineFailure`: fires `sendOpsAlertEmail` with the summary when `sent=0 && errors>0`, deduped to once per hour via `sms-error-alert:<hourBucket>` Redis SET NX.

## Out of scope

- The daily zero-send alert cron at `sms-health-check/route.js` is intentionally untouched. It is correct. The masking chain just denied it usable signal. After this fix it becomes the backstop, not the primary signal.
- Klaviyo gate (`src/lib/klaviyo.js`) untouched. TCPA consent gate is non-negotiable.
- Pre-appointment route untouched.

## Test plan

- [ ] All 244 existing tests still pass
- [ ] 4 new tests in `__tests__/sms-upgrade-scan-route.test.js` pass (HTTP 401, HTTP 500, non-JSON, once-per-hour-alert)
- [ ] After deploy, inject a deliberate failure (see verification section in plan doc) and confirm:
  - Vercel runtime logs show `[sms-upgrade-scan]` line at level `error` with `summary.errors > 0` and `summary.httpStatusCodes` populated
  - Ops email arrives at EMAIL_ESCALATION within 11 minutes
  - Second cron tick within the hour does NOT send a second email (dedupe works)

## QA_ISSUES

cross-cutting #2 (this fix)
EOF
)"
```

### Verification after deploy

- [ ] **Step V1:** Wait for PR2 to merge and deploy

- [ ] **Step V2:** Inject a deliberate failure in a preview deployment

Create a preview branch that temporarily overrides the base URL to a known-401:

```bash
cd ~/sm-member-cancel
git checkout main && git pull
git checkout -b chore/test-observability-failure-injection
```

In `src/app/api/cron/sms-upgrade-scan/route.js`, temporarily change the fallback URL to a deliberately-401 endpoint. Pick `https://httpstat.us/401` which always returns 401:

```js
// TEMPORARY for verification only:
const automationBaseUrl = String(
  process.env.SMS_AUTOMATION_BASE_URL || 'https://httpstat.us',
).trim();
const endpoint = new URL('/401', automationBaseUrl);
```

Push to a preview branch:

```bash
git add src/app/api/cron/sms-upgrade-scan/route.js
git commit -m "chore: temporary 401-injection for PR2 verification (DO NOT MERGE)"
git push -u origin chore/test-observability-failure-injection
```

Vercel will auto-deploy a preview. Note the preview URL.

Manually invoke the cron once against the preview deployment:

```bash
# Replace <preview-url> with the actual preview deployment URL
curl -X GET "https://<preview-url>/api/cron/sms-upgrade-scan" \
  -H "Authorization: Bearer $(vercel env pull .env.preview --environment=preview --yes && grep CRON_SECRET .env.preview | cut -d= -f2)" \
  | jq
```

[PASS] criteria: response JSON contains `summary.errors > 0` and `summary.httpStatusCodes['401'] > 0`.
[FAIL] criteria: response shows `summary.errors === 0`. Observability fix did not work.

- [ ] **Step V3:** Check the ops alert email

Within 11 minutes of the cron run, EMAIL_ESCALATION should receive an email with subject `[Silver Mirror] SMS cron showing HTTP errors with zero sends`.

[PASS] criteria: email received with the summary JSON in the body.
[FAIL] criteria: no email within 15 minutes. Check `sendOpsAlertEmail` config (SMTP_*, EMAIL_ESCALATION env vars).

- [ ] **Step V4:** Trigger a second cron run within the same hour, confirm NO second email

Invoke the cron URL again. The second invocation should NOT trigger a new email (Redis dedupe).

[PASS] criteria: no second email arrives.
[FAIL] criteria: second email arrives. Redis dedupe logic is wrong, inspect `maybeAlertInlineFailure`.

- [ ] **Step V5:** Discard the failure-injection branch (DO NOT MERGE)

```bash
git checkout main
git push origin --delete chore/test-observability-failure-injection
git branch -D chore/test-observability-failure-injection
```

The Vercel preview deployment will be garbage-collected automatically.

- [ ] **Step V6:** Flip QA_ISSUES.md entry to FIXED

```bash
# Update cross-cutting #2 status to "VERIFIED FIXED 2026-05-17"
git checkout main && git pull
# Edit QA_ISSUES.md
git add QA_ISSUES.md
git commit -m "docs(QA_ISSUES): cross-cutting #2 VERIFIED FIXED -- HTTP failures surface as errors and trigger inline alerts"
git push origin main
```

### Rollback for PR2

If the inline alert email becomes noisy or the new error bucketing breaks production logging:

```bash
git log --oneline -5
git revert <merge-sha>
git push origin main
```

System returns to pre-PR2 behavior (HTTP failures silently bucketed as 'unknown'). Daily zero-send alert remains the only signal until the revert is undone. No member impact (PR1 transport fix is independent).

---

## Claude Code execution prompt — PR1

Copy and paste this prompt into a Claude Code session when ready to execute PR1:

```
Execute PR1 from docs/PLAN_sms-outage-fix_2026-05-17.md (Transport fix).

SCOPE: ONE PR that changes the cron's self-fetch base URL to a stable
alias. NO BUNDLING with the observability fix (that is PR2).

READ FIRST:
- docs/PLAN_sms-outage-fix_2026-05-17.md (this plan)
- src/app/api/cron/sms-upgrade-scan/route.js (lines 200-250)
- __tests__/sms-upgrade-scan-route.test.js (existing test patterns)

TOUCH ONLY THESE FILES:
- src/app/api/cron/sms-upgrade-scan/route.js (lines 205-207 only)
- __tests__/sms-upgrade-scan-route.test.js (add 2 test cases)
- .env.example (add SMS_AUTOMATION_BASE_URL doc block)
- QA_ISSUES.md (add outbound-sms #10 entry)

DO NOT TOUCH:
- src/app/api/sms/automation/pre-appointment/route.js
- src/lib/sms-metrics.js, src/lib/klaviyo.js, src/lib/twilio.js, src/lib/boulevard.js
- src/app/api/cron/sms-health-check/route.js
- system-prompt.txt, any cancel-bot logic
- vercel.json

FOLLOW THE EXACT STEPS IN THE PLAN (Steps 1-12 under "PR1 / Implementation steps").

Use HEREDOC for the commit message. No em dashes or en dashes anywhere.
After push, run `gh pr create` with the exact body template in the plan.

After the PR opens, STOP. Do not merge. Wait for Matt to review and merge.
```

## Claude Code execution prompt — PR2

Copy and paste this prompt into a Claude Code session AFTER PR1 has been merged AND verification steps V1 through V5 in PR1 have all passed:

```
Execute PR2 from docs/PLAN_sms-outage-fix_2026-05-17.md (Observability fix).

PREREQUISITES:
- PR1 (Transport fix) is merged to main
- PR1 verification V1-V5 all passed (sms-sent Redis key materialized, sends resumed)
- QA_ISSUES.md outbound-sms #10 status is "VERIFIED FIXED"

If any prerequisite is not met, STOP and report. Do not proceed.

SCOPE: ONE PR that fixes the 4-link masking chain in checkOneCandidate
and adds an inline ops email alert. NO BUNDLING with anything else.

READ FIRST:
- docs/PLAN_sms-outage-fix_2026-05-17.md (this plan)
- src/app/api/cron/sms-upgrade-scan/route.js (full file)
- src/lib/notify.js (to confirm sendOpsAlertEmail signature)
- __tests__/sms-upgrade-scan-route.test.js (mock patterns)

TOUCH ONLY THESE FILES:
- src/app/api/cron/sms-upgrade-scan/route.js (rewrite lines 113-145, replace
  lines 227-247, add imports + 2 helpers near top of file)
- __tests__/sms-upgrade-scan-route.test.js (add 4 test cases)
- QA_ISSUES.md (add cross-cutting #2 entry)

DO NOT TOUCH:
- src/lib/notify.js (reuse existing sendOpsAlertEmail import only)
- src/app/api/sms/automation/pre-appointment/route.js
- src/lib/sms-metrics.js, src/lib/klaviyo.js, src/lib/twilio.js, src/lib/boulevard.js
- src/app/api/cron/sms-health-check/route.js (daily alert untouched)
- src/lib/missed-call-dispatcher.js
- system-prompt.txt, any cancel-bot logic

FOLLOW THE EXACT STEPS IN THE PLAN (Steps 1-12 under "PR2 / Implementation steps").

Use HEREDOC for the commit message. No em dashes or en dashes anywhere.
After push, run `gh pr create` with the exact body template in the plan.

After the PR opens, STOP. Do not merge. Wait for Matt to review and merge.
After merge, execute verification steps V1-V6 including the failure-injection
preview deployment. The injection branch MUST be deleted after V5 - DO NOT
merge it to main.
```

---

## Cross-PR risk register

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `sm-member-cancel.vercel.app` alias gets accidentally removed | Low | Vercel auto-manages this alias for linked projects. PR1 has an env var override path. |
| In-process route handler invocation might be cleaner | Medium | Tracked as future refactor PR. Out of scope for outage response. |
| Inline ops email becomes noisy if a transient 5xx hits every 10 min | Low | 1-hour Redis dedupe caps to 24 emails/day worst case. If still noisy, PR3 can raise the threshold or add `errors > N` instead of `errors > 0`. |
| PR1 ships but sends still don't resume | Low | Verification V3 catches this before declaring fixed. Hypothesis falsifiable, escalate to in-process refactor if needed. |
| Failure-injection branch accidentally merged | Low | PR2 verification step V5 explicitly deletes the branch. Branch name `chore/test-observability-failure-injection` is clearly marked DO NOT MERGE. |

---

## Plan self-review

- [x] Spec coverage: ship order ✓, transport pick ✓, observability design ✓, verification ✓, rollback ✓, prompts ✓
- [x] No placeholders ("TBD", "implement later", etc.) — every code block contains actual content
- [x] Type consistency: `summary.httpStatusCodes`, `summary.errorsByReason`, `val.httpStatus`, `val.ok` used consistently across checkOneCandidate, summary builder, and tests
- [x] All file paths absolute or repo-relative
- [x] No em dashes or en dashes in any text I added (per CLAUDE.md)
- [x] Klaviyo gate, system-prompt.txt, sms-health-check, missed-call-dispatcher explicitly excluded
- [x] Each PR section self-contained — Claude Code can execute either without re-reading the other
- [x] Verification steps have explicit [PASS] / [FAIL] criteria
- [x] Rollback for each PR documented

## Plan status

READY FOR EXECUTION. Matt to review, then hand the PR1 execution prompt to Claude Code in a fresh session.

Order: PR1 first (active outage), then PR2 within 24 hours of PR1 verification green.
