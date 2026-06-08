# SMS Cron Alert Emails: Silence Healthy Runs, Alert Only On Real Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop emailing Matt on healthy SMS upgrade-scan runs, email him only on three real conditions in plain English, and add the session identifiers Richa needs on the chatbot-incident emails.

**Architecture:** Centralize the alert decision and the plain-language email copy in `src/lib/notify.js` as small pure functions, then call them from the cron summary trigger. The per-run scan classifier covers conditions (a) and (d). The daily zero-send condition (b) stays in the existing `sms-health-check` cron; it always fires on a zero-send day and uses a new daily candidate counter only to soften the wording, never to gate the email. Condition (c), the upgrade-verification-failed alert, is explicitly OUT of this PR (separate follow-up). The incident-email change adds only identifiers that already exist at send time.

**Tech Stack:** Next.js 14 App Router route handlers, Upstash Redis (`@upstash/redis`), Nodemailer, Vitest.

**Conditions in this PR:** (a) 2+ errors in a run, (b) daily zero-send, (d) an add-on actually sent. Condition (c) is removed (see "NOT in scope").

---

## Current behavior (confirmed in code before any change)

### The noisy trigger

`src/app/api/cron/sms-upgrade-scan/route.js:334`:

```js
if (summary.sent === 0 && summary.errors > 0) {
  await maybeAlertInlineFailure(summary).catch(err => { ... });
}
```

The email fires on any run where `sent === 0` and `errors >= 1`. There is no retry in the cron: `checkOneCandidate` (`:156`) does a single `fetch`, and on `!res.ok` returns `{ status: 'error', reason: 'http_' + res.status, httpStatus: res.status, ok: false }` (`:171-178`). One transient downstream `http_500` therefore makes `summary.errors = 1`, and on a run with `sent = 0` and otherwise all-legitimate skips, Matt is emailed. That is the noise.

### The email builder and its raw-JSON dump

`maybeAlertInlineFailure(summary)` (`:71-97`) builds a subject `[Silver Mirror] SMS cron showing HTTP errors with zero sends` and a body that opens with raw counts and dumps `errorsByReason` / `skippedByReason` / `httpStatusCodes` JSON (`:87-89`). There is no plain-English verdict line; a non-engineer cannot tell whether action is needed.

### The chatbot-incident emails

`sendSupportIncidentEmail(incident)` in `src/lib/notify.js:273-324`, subject `[Chatbot Incident] ${incident.issue_type} — session ${incident.session_id}` (`:293`). Built from the `incident` object created at `src/app/api/chat/message/route.js:835-844`. Recipient is `EMAIL_QA_ALERT` (default `qatesting@silvermirror.com`, `:279`); this is Richa's channel and does not change.

---

## Resolved questions (read-only, answered before any change)

### Q1. Is the cron alert rate-limited / deduped today? Show the mechanism.

Yes. `maybeAlertInlineFailure` (`:71-78`) uses Upstash Redis:

```js
const hourBucket = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
const alertKey = `sms-error-alert:${hourBucket}`;
if (redis) {
  const set = await redis.set(alertKey, '1', { nx: true, ex: 3600 });
  if (!set) return false; // already alerted this hour -> no email
}
```

`SET ... NX EX 3600`: the first alert in a clock hour sets the key; later alerts that hour find it present and return without emailing. When Redis is not configured there is no dedup (prod has Redis).

How the new logic composes with it: the threshold decision runs first; only if it says "alert" do we touch the dedup key. To stop one condition from masking another within the same hour, this plan uses **per-condition** dedup keys (`sms-alert:errors:<hour>`, `sms-alert:addon:<hour>`) instead of the single `sms-error-alert:<hour>` key. Each condition is still rate-limited to once per hour.

### Q2. Condition (b), daily zero-send: existing aggregation or new?

Mostly existing. `src/lib/sms-metrics.js` keeps a daily send counter in Redis at `sms-sent:<YYYY-MM-DD>` (`:5`, `:35-47`, `:50-61`), bumped once per real Twilio send (`pre-appointment/route.js:1124`). The `sms-health-check` cron (`vercel.json` `0 14 * * *`) reads yesterday's count and emails when `sends < SMS_MIN_DAILY_SENDS` (default 1).

What is missing is plain copy and a way to soften the wording on a legitimately quiet day. There is no daily candidate counter.

Decision (from eng-review, finding #1): the candidate count is added as a NEW daily counter (`sms-candidates:<YYYY-MM-DD>`, mirroring the send counter), but it is used ONLY to soften the copy. The zero-send email ALWAYS fires when `sends < threshold`. It is never gated on candidates, because the upgrade-scan cron records candidates only after its early returns (window closed at `:225`, `SMS_CRON_ENABLED` false at `:216`, no appointments at `:258-267`). A broken, disabled, or dead scan therefore writes zero candidates, and gating on `candidates > 0` would suppress the alert during the exact outage the daily check exists to catch (the April 2026 three-week silent outage, per the route comment). Never suppress. Soften copy only.

### Q3. Incident emails: exactly which identifier fields exist at send time?

At the trigger (`route.js:835-844`) and in route scope, available without inventing anything:

- `incident.session_id` (= `sessionId`): the internal chat session ID. Already in the subject and body.
- `sessionCreated`: `new Date(session.createdAt).toISOString()` (`route.js:772`), the session start time. In scope at the trigger but NOT currently copied into `incident`. It keys the Chatlog Sheet rows.
- `incident.date`, `issue_type`, `name`, `email`, `phone`, `location`, `user_message`.
- `GOOGLE_CHATLOG_SHEET_ID` env (confirmed set per CLAUDE.md, read at `notify.js:597`): the Chatlog Sheet, rows keyed by session ID + `sessionCreated`.

What does NOT exist (so we will not invent it): no Microsoft Clarity integration, no Clarity session URL, no shared Clarity ID, no `conversationId` distinct from `session_id`. We cannot deep-link to Clarity. We CAN give Richa a more direct path: the session ID, the session start time, and a link to the Chatlog Sheet she opens and filters by session ID to read the actual transcript. The plan adds exactly those three.

### Q4. Where does each alert condition become detectable?

- (a) `errors >= 2`: from the scan run summary. Detectable in the cron.
- (d) add-on send: a sent result carries `offerKind` (`pre-appointment/route.js:1131`, `'duration'` or `'addon'`). The cron's `checkOneCandidate` (`:193-199`) keeps only `status` and `reason: r.reason || r.offerKind`, so a sent add-on collapses into the sent count. Detection needs an additive `offerKind` passthrough on the cron result plus an `addonSends` tally.
- (b) daily zero-send: `sms-health-check` cron plus the new candidate counter (copy only).
- (c) `upgrade_verification_failed`: OUT of this PR. See "NOT in scope."

### Q5. Can the cron's single-candidate call return `status:'queued'` (condition d edge)?

No, confirmed. `status:'queued'` is returned only when `queueWhenOutsideWindow` is true, with `reason:'queued_outside_send_window'` (`pre-appointment/route.js:555-584`). The upgrade-scan cron early-returns BEFORE calling the endpoint when outside the send window (`:225`), so its calls are always in-window and never hit the queue path. Furthermore the queued result row (`:572-584`) carries NO `offerKind` field, so a queued row could not be identified as an add-on even if it occurred. Therefore condition (d) counts add-ons on `status === 'sent' && offerKind === 'addon'` only. We deliberately do not count `'queued'`: it is unreachable from the cron and structurally unclassifiable as an add-on. A queued candidate that later drains and actually sends an add-on would surface as a `'sent'` add-on at its own send time.

---

## The alert model (single source of truth)

Healthy (NO email) per run: `errors <= 1` and `addonSends === 0`. A run that is `sent = 0` with all-legitimate skips and one `http_500` (`errors = 1`) sends NO email. A run with `sent > 0` and `errors = 1` also sends NO email (this is the exact over-firing shape being fixed).

Alert (email) when ANY is true:
- (a) `summary.errors >= 2` in a single scan run.
- (d) `summary.addonSends >= 1` (an add-on offer actually went out; the wall broke).
- (b) yesterday `sends < SMS_MIN_DAILY_SENDS` (daily health check). Always fires; the candidate count only changes the wording.

No daily summary email. Total silence except these.

Note on (a) vs the old trigger: the old condition required `sent === 0`. The new (a) does not. A run with `sent = 5, errors = 2` now alerts (two real errors regardless of sends); the old code suppressed it. That is intended and more correct.

```
PER-RUN SCAN (sms-upgrade-scan, every 10 min, in-window)
  results[] --> tallyRunSummary() --> summary{sent,skipped,errors,addonSends,...}
                                          |
                                 classifyUpgradeScanRun(summary)
                                   errors>=2 ? add 'errors'
                                   addonSends>=1 ? add 'addon'
                                          |
                             shouldAlert && per-condition Redis NX dedup
                                          |
                              buildUpgradeScanAlert(summary, freshConditions)
                                          |
                                  sendOpsAlertEmail(EMAIL_OPS_ALERTS)

DAILY (sms-health-check, 14:00 UTC)
  getDailySendCount(yesterday)      --> sends
  getDailyCandidateCount(yesterday) --> candidates   (copy only, never gates)
                                          |
                              sends < threshold ? ALWAYS alert
                                          |
                       buildDailyZeroSendAlert({sends,candidates,...})
                         candidates==0 -> "may be a quiet day, verify"
                         candidates>0  -> "eligible members got nothing"
                                          |
                                  sendOpsAlertEmail(EMAIL_OPS_ALERTS)
```

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/lib/notify.js` | Modify | New pure helpers: `formatOpsAlert({verdict, whatToDo, technical})`, `tallyRunSummary(results)`, `classifyUpgradeScanRun(summary)`, `buildUpgradeScanAlert(summary, conditions)`, `buildDailyZeroSendAlert({dateStr, sends, candidates, threshold})`. Add session identifiers to `sendSupportIncidentEmail`. Export the pure helpers for unit tests. |
| `src/app/api/cron/sms-upgrade-scan/route.js` | Modify | Add `offerKind` passthrough on the candidate result; use `tallyRunSummary`; replace the `:334` trigger with the classifier; per-condition dedup; increment the daily candidate counter. |
| `src/lib/sms-metrics.js` | Modify | Add `incrementDailyCandidateCount(by, when)` and `getDailyCandidateCount(dateStr)`, mirroring the send counter. |
| `src/app/api/cron/sms-health-check/route.js` | Modify | Read the candidate count; always alert on `sends < threshold`; delegate copy to `buildDailyZeroSendAlert`. |
| `src/app/api/chat/message/route.js` | Modify | Pass `sessionCreated` into the incident object (incident-email change only). |
| `__tests__/notify-upgrade-scan-alert.test.js` | Create | Unit tests for `tallyRunSummary`, the classifier, and the alert builders (conditions a, d, and silence cases). |
| `__tests__/notify.test.js` | Modify | Tests for the incident-email identifier additions. |
| `__tests__/sms-health-check-route.test.js` | Modify | Tests for always-fire + softened copy (condition b). |
| `__tests__/sms-metrics.test.js` | Modify | Tests for the candidate counter. |

No em dashes anywhere in code, comments, copy, commits, or PR text. Use commas, semicolons, or sentence breaks.

---

### Task 1: Pure alert helpers in notify.js (formatOpsAlert, tallyRunSummary, classifier, builders)

**Files:**
- Modify: `src/lib/notify.js`
- Test: `__tests__/notify-upgrade-scan-alert.test.js` (create)

- [ ] **Step 1: Write the failing tests**

Create `__tests__/notify-upgrade-scan-alert.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  tallyRunSummary,
  classifyUpgradeScanRun,
  buildUpgradeScanAlert,
  buildDailyZeroSendAlert,
} from '../src/lib/notify.js';

describe('tallyRunSummary', () => {
  it('counts sent, skipped, errors, addonSends, and reason histograms', () => {
    const results = [
      { status: 'sent', offerKind: 'duration', httpStatus: 200, ok: true },
      { status: 'sent', offerKind: 'addon', httpStatus: 200, ok: true },
      { status: 'skipped', reason: 'klaviyo_not_subscribed', httpStatus: 200, ok: true },
      { status: 'error', reason: 'http_500', httpStatus: 500, ok: false },
    ];
    const s = tallyRunSummary(results);
    expect(s.total).toBe(4);
    expect(s.sent).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.addonSends).toBe(1);
    expect(s.errorsByReason).toEqual({ http_500: 1 });
    expect(s.skippedByReason).toEqual({ klaviyo_not_subscribed: 1 });
    expect(s.httpStatusCodes).toEqual({ '200': 3, '500': 1 });
  });

  it('does not count a duration send as an add-on', () => {
    const s = tallyRunSummary([{ status: 'sent', offerKind: 'duration', httpStatus: 200, ok: true }]);
    expect(s.sent).toBe(1);
    expect(s.addonSends).toBe(0);
  });
});

describe('classifyUpgradeScanRun', () => {
  const healthy = { total: 10, sent: 0, skipped: 10, errors: 0, addonSends: 0 };

  it('healthy run does not alert', () => {
    expect(classifyUpgradeScanRun(healthy).shouldAlert).toBe(false);
  });

  it('one absorbed http_500 on a sent=0 run does not alert', () => {
    expect(classifyUpgradeScanRun({ ...healthy, sent: 0, skipped: 9, errors: 1 }).shouldAlert).toBe(false);
  });

  it('sent>0 with one error does not alert (the exact over-firing shape being fixed)', () => {
    const r = classifyUpgradeScanRun({ ...healthy, sent: 5, skipped: 4, errors: 1 });
    expect(r.shouldAlert).toBe(false);
    expect(r.conditions).toEqual([]);
  });

  it('two or more errors alerts on condition a', () => {
    const r = classifyUpgradeScanRun({ ...healthy, errors: 2 });
    expect(r.shouldAlert).toBe(true);
    expect(r.conditions).toContain('errors');
  });

  it('an add-on send alerts on condition d even with zero errors', () => {
    const r = classifyUpgradeScanRun({ ...healthy, sent: 1, addonSends: 1 });
    expect(r.shouldAlert).toBe(true);
    expect(r.conditions).toContain('addon');
  });
});

describe('buildUpgradeScanAlert', () => {
  const base = { total: 10, sent: 0, skipped: 7, errors: 3, addonSends: 0,
    errorsByReason: { http_500: 2, http_502: 1 }, skippedByReason: {}, httpStatusCodes: {} };

  it('leads with a plain verdict and puts JSON after the technical-detail line', () => {
    const { subject, text } = buildUpgradeScanAlert(base, ['errors']);
    const firstLine = text.split('\n')[0];
    expect(firstLine).toMatch(/^Needs attention: the upgrade scan hit 3 errors/);
    expect(firstLine).not.toMatch(/[{}]/);
    expect(subject).toMatch(/Needs attention/i);
    const techIdx = text.indexOf('Technical detail');
    const jsonIdx = text.indexOf('errorsByReason');
    expect(techIdx).toBeGreaterThan(0);
    expect(jsonIdx).toBeGreaterThan(techIdx);
  });

  it('leads with a plain verdict for the add-on condition', () => {
    const { text } = buildUpgradeScanAlert({ ...base, errors: 0, sent: 1, addonSends: 1 }, ['addon']);
    expect(text.split('\n')[0]).toMatch(/^Needs attention: an add-on offer was actually texted/);
  });

  it('no em dashes anywhere', () => {
    const { text, subject } = buildUpgradeScanAlert(base, ['errors']);
    expect(text + subject).not.toContain('—');
  });
});

describe('buildDailyZeroSendAlert', () => {
  it('candidates>0 says eligible members got nothing', () => {
    const { subject, text } = buildDailyZeroSendAlert({ dateStr: '2026-06-07', sends: 0, candidates: 42, threshold: 1 });
    expect(text.split('\n')[0]).toMatch(/^Needs attention: no upgrade texts went out/);
    expect(text).toContain('42 eligible members');
    expect(subject).toMatch(/Needs attention/i);
  });

  it('candidates=0 softens to a quiet-day verify note but still reads as an alert email', () => {
    const { subject, text } = buildDailyZeroSendAlert({ dateStr: '2026-06-07', sends: 0, candidates: 0, threshold: 1 });
    expect(text.split('\n')[0]).toMatch(/quiet day/i);
    expect(text).toMatch(/verify the scan is running/i);
    expect(subject).toMatch(/Heads up/i);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run __tests__/notify-upgrade-scan-alert.test.js`
Expected: FAIL with "tallyRunSummary is not a function" (not exported yet).

- [ ] **Step 3: Add the pure helpers to `src/lib/notify.js`**

Add near the other builders (after `sendOpsAlertEmail`, around `:368`). All pure (no IO):

```js
// ── Ops alert formatting (shared shape: verdict first, JSON last) ────────────
// Every ops alert reads the same way for a non-engineer: a plain-English verdict
// on top, a one-line "What to do", then a "Technical detail" block for
// engineering. technical is an array of already-formatted lines.
function formatOpsAlert({ verdict, whatToDo, technical }) {
  const verdictLines = Array.isArray(verdict) ? verdict : [verdict];
  return [
    ...verdictLines,
    '',
    `What to do: ${whatToDo}`,
    '',
    'Technical detail (for engineering):',
    ...(technical || []),
  ].join('\n');
}

// ── SMS upgrade-scan alerting ───────────────────────────────────────────────
// Fold the per-candidate cron results into the run summary. Pure so the tally
// (especially addonSends) is unit-tested directly without the route harness.
function tallyRunSummary(results) {
  const summary = {
    total: results.length,
    sent: 0, skipped: 0, errors: 0, addonSends: 0,
    skippedByReason: {}, errorsByReason: {}, httpStatusCodes: {},
  };
  for (const val of results) {
    if (val.httpStatus != null) {
      const code = String(val.httpStatus);
      summary.httpStatusCodes[code] = (summary.httpStatusCodes[code] || 0) + 1;
    }
    if (val.status === 'sent') {
      summary.sent++;
      if (val.offerKind === 'addon') summary.addonSends++;
    } else if (val.status === 'error' || !val.ok) {
      summary.errors++;
      const reason = val.reason || 'unknown';
      summary.errorsByReason[reason] = (summary.errorsByReason[reason] || 0) + 1;
    } else {
      summary.skipped++;
      const reason = val.reason || 'unknown';
      summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
    }
  }
  return summary;
}

// Decide whether a single scan run needs a human. Healthy runs stay silent: at
// most one transient error absorbed (errors <= 1) and no add-on sent. Returns
// { shouldAlert, conditions } where conditions is a subset of ['errors', 'addon'].
function classifyUpgradeScanRun(summary) {
  const errors = Number(summary?.errors || 0);
  const addonSends = Number(summary?.addonSends || 0);
  const conditions = [];
  if (errors >= 2) conditions.push('errors');
  if (addonSends >= 1) conditions.push('addon');
  return { shouldAlert: conditions.length > 0, conditions };
}

function buildUpgradeScanAlert(summary, conditions) {
  const errors = Number(summary?.errors || 0);
  const addonSends = Number(summary?.addonSends || 0);
  const verdict = [];
  if (conditions.includes('errors')) {
    verdict.push(`Needs attention: the upgrade scan hit ${errors} errors in a single run. A healthy run absorbs at most one transient hiccup, so this one needs an engineer to look.`);
  }
  if (conditions.includes('addon')) {
    verdict.push(`Needs attention: an add-on offer was actually texted to a member (${addonSends} this run). Add-on texts are supposed to be impossible from this pipeline, so the safeguard may have broken. Please have engineering check immediately.`);
  }
  const technical = [
    `total=${summary?.total ?? 0} sent=${summary?.sent ?? 0} skipped=${summary?.skipped ?? 0} errors=${errors} addonSends=${addonSends}`,
    `errorsByReason: ${JSON.stringify(summary?.errorsByReason || {})}`,
    `skippedByReason: ${JSON.stringify(summary?.skippedByReason || {})}`,
    `httpStatusCodes: ${JSON.stringify(summary?.httpStatusCodes || {})}`,
    'Logs: Vercel cron logs, filter "[sms-upgrade-scan]" at error level.',
  ];
  return {
    subject: `[Silver Mirror] Needs attention: SMS upgrade scan`,
    text: formatOpsAlert({
      verdict,
      whatToDo: 'forward this to engineering. No member action is needed from you.',
      technical,
    }),
  };
}

// Daily zero-send. ALWAYS fires when sends < threshold; the candidate count only
// softens the wording. Never gate the email on candidates: a broken or disabled
// scan records zero candidates, and suppressing on candidates==0 would re-open
// the silent-outage hole the daily check exists to catch.
function buildDailyZeroSendAlert({ dateStr, sends, candidates, threshold }) {
  const quiet = Number(candidates) === 0;
  const verdict = quiet
    ? `Heads up: no upgrade texts went out yesterday (${dateStr}), and 0 eligible members were scanned. This may be a genuinely quiet day, so verify the scan is running before treating it as an outage.`
    : `Needs attention: no upgrade texts went out yesterday (${dateStr}) even though ${candidates} eligible members were scanned. ${sends} send(s) recorded, below the threshold of ${threshold}.`;
  const whatToDo = quiet
    ? 'confirm the scan actually ran yesterday; if it ran and there were truly no eligible members, no action is needed.'
    : 'forward this to engineering. Sending likely stalled (env flag off, Boulevard or Twilio failing, or the approval gate holding everything).';
  const technical = [
    `date=${dateStr} sends=${sends} candidates=${candidates} threshold=${threshold}`,
    '1. Vercel cron logs for "[sms-upgrade-scan]": summary.sent and summary.skippedByReason.',
    '2. SMS_CRON_ENABLED / SMS_REQUIRE_MANUAL_LIVE_APPROVAL / SMS_UPGRADE_STATUS env values.',
    '3. Redis registry counts (HLEN sms-registry:loc:*).',
    'See docs/outbound-sms-system-and-issues.md and QA_ISSUES.md (outbound-sms section).',
  ];
  return {
    subject: `[Silver Mirror] ${quiet ? 'Heads up' : 'Needs attention'}: outbound SMS on ${dateStr}`,
    text: formatOpsAlert({ verdict, whatToDo, technical }),
  };
}
```

Add to the export list at the bottom of `notify.js` (match the existing style):

```js
  tallyRunSummary,
  classifyUpgradeScanRun,
  buildUpgradeScanAlert,
  buildDailyZeroSendAlert,
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run __tests__/notify-upgrade-scan-alert.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notify.js __tests__/notify-upgrade-scan-alert.test.js
git commit -m "feat(sms): plain-language alert helpers for the upgrade scan and daily zero-send"
```

---

### Task 2: Wire the cron trigger to the classifier (silence healthy runs, conditions a + d)

**Files:**
- Modify: `src/app/api/cron/sms-upgrade-scan/route.js`

- [ ] **Step 1: Add an `offerKind` passthrough on the candidate result**

In `checkOneCandidate` (`:193-199`), add the field (additive, read-only):

```js
    const r = payload?.results?.[0] || {};
    return {
      candidate: candidateName,
      status: r.status || 'unknown',
      reason: r.reason || r.offerKind || null,
      offerKind: r.offerKind || null,
      httpStatus: res.status,
      ok: true,
    };
```

- [ ] **Step 2: Replace the inline summary build with `tallyRunSummary`**

Update the import (`:11`):

```js
import { sendOpsAlertEmail, tallyRunSummary, classifyUpgradeScanRun, buildUpgradeScanAlert } from '../../../../lib/notify';
```

Replace the inline summary object and loop (`:294-318`) with:

```js
  const summary = tallyRunSummary(allResults);
```

The `payload`, `summaryLogPayload`, and the `console.error`/`console.log` lines (`:320-333`) stay as-is; `summary` now has the same shape plus `addonSends`.

- [ ] **Step 3: Replace `maybeAlertInlineFailure` with per-condition dedup**

Rewrite `maybeAlertInlineFailure` (`:71-97`) as:

```js
async function maybeAlertForRun(summary, conditions) {
  const redis = getAlertRedis();
  const hourBucket = new Date().toISOString().slice(0, 13);
  // Per-condition dedup so an early errors alert does not mask a later add-on
  // breach in the same hour. Each condition is rate-limited to once per hour.
  const fresh = [];
  for (const cond of conditions) {
    if (!redis) { fresh.push(cond); continue; }
    const set = await redis.set(`sms-alert:${cond}:${hourBucket}`, '1', { nx: true, ex: 3600 });
    if (set) fresh.push(cond);
  }
  if (fresh.length === 0) return false;
  const { subject, text } = buildUpgradeScanAlert(summary, fresh);
  const result = await sendOpsAlertEmail({ subject, text });
  return result?.sent === true;
}
```

- [ ] **Step 4: Replace the trigger at the call site (`:334-338`)**

```js
  const { shouldAlert, conditions } = classifyUpgradeScanRun(summary);
  if (shouldAlert) {
    await maybeAlertForRun(summary, conditions).catch(err => {
      console.error('[sms-upgrade-scan] inline alert failed:', err?.message || err);
    });
  }
```

- [ ] **Step 5: Verify the suite is green**

Run: `npx vitest run`
Expected: PASS. No route-level test exists for sms-upgrade-scan; `tallyRunSummary` and the classifier are covered by Task 1 units. The whole-suite run confirms no import or reference regressions.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/sms-upgrade-scan/route.js
git commit -m "fix(sms): silence healthy upgrade-scan runs, alert only on 2+ errors or an add-on send"
```

---

### Task 3: Daily zero-send, always-fire with softened copy (condition b)

**Files:**
- Modify: `src/lib/sms-metrics.js`
- Modify: `src/app/api/cron/sms-upgrade-scan/route.js`
- Modify: `src/app/api/cron/sms-health-check/route.js`
- Test: `__tests__/sms-metrics.test.js`, `__tests__/sms-health-check-route.test.js`

- [ ] **Step 1: Write the failing metrics test**

Append to `__tests__/sms-metrics.test.js`, mirroring the file's existing Redis mock used by the send-counter tests:

```js
describe('daily candidate counter', () => {
  it('incrementDailyCandidateCount adds by N (INCRBY) and sets TTL on first write', async () => {
    // Mirror the send-counter mock: redis.incrby returns the new total, expire is
    // called when total === N. Assert incrby(key, 7) and expire on first write.
  });
  it('getDailyCandidateCount reads the stored number, 0 when unknown', async () => {
    // Mirror the getDailySendCount test.
  });
});
```

Fill the bodies using the same `getRedis` mock the send-counter tests already use; assert `incrby(key, 7)` and `expire` on first write, and a `get` round-trip.

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run __tests__/sms-metrics.test.js -t "daily candidate counter"`
Expected: FAIL with "incrementDailyCandidateCount is not a function".

- [ ] **Step 3: Add the candidate counter to `src/lib/sms-metrics.js`**

```js
const CANDIDATE_KEY_PREFIX = 'sms-candidates:';

// Add `by` candidates to today's counter (metrics timezone). No-op when Redis is
// not configured. Never throws. Uses INCRBY because a scan run finds many at once.
export async function incrementDailyCandidateCount(by = 1, when = new Date()) {
  const redis = getRedis();
  if (!redis) return false;
  const n = Number(by);
  if (!Number.isFinite(n) || n <= 0) return false;
  const key = `${CANDIDATE_KEY_PREFIX}${localDateStr(when)}`;
  try {
    const total = await redis.incrby(key, n);
    if (total === n) await redis.expire(key, SENT_TTL_SECONDS);
    return true;
  } catch (err) {
    console.warn('[sms-metrics] candidate incr failed:', err?.message || err);
    return false;
  }
}

export async function getDailyCandidateCount(dateStr) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get(`${CANDIDATE_KEY_PREFIX}${dateStr}`);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.warn('[sms-metrics] candidate get failed:', err?.message || err);
    return 0;
  }
}
```

- [ ] **Step 4: Increment the candidate counter once per scan run**

In `src/app/api/cron/sms-upgrade-scan/route.js`, import it:

```js
import { incrementDailyCandidateCount } from '../../../../lib/sms-metrics';
```

After candidates are discovered and known non-empty (after `:267`, before processing):

```js
  // Record how many candidates this run found, so the daily health check can word
  // a zero-send day correctly. This is copy-only signal; it never gates the alert.
  await incrementDailyCandidateCount(candidates.length).catch(() => {});
```

- [ ] **Step 5: Run the metrics test and verify it passes**

Run: `npx vitest run __tests__/sms-metrics.test.js -t "daily candidate counter"`
Expected: PASS.

- [ ] **Step 6: Write the failing health-check tests**

In `__tests__/sms-health-check-route.test.js`, add `getDailyCandidateCount` to the `sms-metrics.js` mock, then:

```js
it('ALWAYS alerts on zero sends, even when no candidates were recorded (outage backstop)', async () => {
  getDailySendCount.mockResolvedValue(0);
  getDailyCandidateCount.mockResolvedValue(0);
  const { GET } = await loadRoute();
  const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, alerted: true });
  expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);
  expect(sendOpsAlertEmail.mock.calls[0][0].text).toMatch(/quiet day/i);
});

it('alerts with the firmer verdict when sends are zero AND candidates existed', async () => {
  getDailySendCount.mockResolvedValue(0);
  getDailyCandidateCount.mockResolvedValue(42);
  const { GET } = await loadRoute();
  const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
  await res.json();
  const text = sendOpsAlertEmail.mock.calls[0][0].text;
  expect(text.split('\n')[0]).toMatch(/^Needs attention: no upgrade texts went out/);
  expect(text).toContain('42 eligible members');
});

it('does not alert when the threshold was met', async () => {
  getDailySendCount.mockResolvedValue(12);
  getDailyCandidateCount.mockResolvedValue(50);
  const { GET } = await loadRoute();
  const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, alerted: false });
  expect(sendOpsAlertEmail).not.toHaveBeenCalled();
});
```

- [ ] **Step 7: Run it and verify it fails**

Run: `npx vitest run __tests__/sms-health-check-route.test.js`
Expected: FAIL (the quiet-day-still-alerts case and the verdict wording are not implemented; the existing below-threshold test may assert the old subject).

- [ ] **Step 8: Update the health check to always fire and delegate copy**

In `src/app/api/cron/sms-health-check/route.js`:

```js
import { getDailySendCount, getDailyCandidateCount, localDateStr } from '../../../../lib/sms-metrics';
import { sendOpsAlertEmail, buildDailyZeroSendAlert } from '../../../../lib/notify';
```

```js
  const threshold = Math.max(0, Number(process.env.SMS_MIN_DAILY_SENDS || 1));
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = localDateStr(yesterday);
  const sends = await getDailySendCount(dateStr);
  const candidates = await getDailyCandidateCount(dateStr);

  if (sends < threshold) {
    const { subject, text } = buildDailyZeroSendAlert({ dateStr, sends, candidates, threshold });
    const result = await sendOpsAlertEmail({ subject, text });
    console.warn('[sms-health-check]', JSON.stringify({ alerted: true, emailSent: result?.sent === true, yesterdaySends: sends, candidates, threshold, date: dateStr }));
    return NextResponse.json({ ok: true, alerted: true, emailSent: result?.sent === true, yesterdaySends: sends, candidates, threshold, date: dateStr });
  }

  console.log('[sms-health-check]', JSON.stringify({ alerted: false, yesterdaySends: sends, candidates, threshold, date: dateStr }));
  return NextResponse.json({ ok: true, alerted: false, yesterdaySends: sends, candidates, threshold, date: dateStr });
```

- [ ] **Step 9: Run the health-check tests and verify they pass**

Run: `npx vitest run __tests__/sms-health-check-route.test.js`
Expected: PASS. Update any pre-existing test in this file that asserted the old subject text to the new builder output, and set `getDailyCandidateCount` per case.

- [ ] **Step 10: Commit**

```bash
git add src/lib/sms-metrics.js src/app/api/cron/sms-upgrade-scan/route.js src/app/api/cron/sms-health-check/route.js __tests__/sms-metrics.test.js __tests__/sms-health-check-route.test.js
git commit -m "fix(sms): daily zero-send alert always fires, candidate count only softens the copy"
```

---

### Task 4: Richa's session identifiers on the incident email

**Files:**
- Modify: `src/lib/notify.js`
- Modify: `src/app/api/chat/message/route.js`
- Test: `__tests__/notify.test.js`

- [ ] **Step 1: Write the failing test**

Add to `__tests__/notify.test.js`, using the existing nodemailer mock:

```js
describe('chatbot incident email identifiers', () => {
  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.GOOGLE_CHATLOG_SHEET_ID = 'SHEET123';
    sendMail.mockClear();
  });

  it('includes session id, session start time, and a chatlog sheet link', async () => {
    vi.resetModules();
    const { sendSupportIncidentEmail } = await import('../src/lib/notify.js');
    await sendSupportIncidentEmail({
      date: '2026-06-08T12:00:00.000Z',
      session_id: 'sess_xyz',
      session_created: '2026-06-08T11:58:00.000Z',
      issue_type: 'booking_payment_issue',
      user_message: 'my payment failed',
    });
    const body = sendMail.mock.calls[0][0].text;
    expect(body).toContain('Session ID: sess_xyz');
    expect(body).toContain('Session started: 2026-06-08T11:58:00.000Z');
    expect(body).toContain('https://docs.google.com/spreadsheets/d/SHEET123');
    expect(body).not.toContain('—');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run __tests__/notify.test.js -t "incident email identifiers"`
Expected: FAIL (no session-start line, no sheet link; possibly `sendSupportIncidentEmail` not exported).

- [ ] **Step 3: Add identifiers to `sendSupportIncidentEmail` (notify.js:293-309)**

Replace the subject and body:

```js
  const subject = `[Chatbot Incident] ${incident.issue_type} for session ${incident.session_id}`;
  const chatlogSheetId = String(process.env.GOOGLE_CHATLOG_SHEET_ID || '').trim();
  const chatlogLink = chatlogSheetId
    ? `https://docs.google.com/spreadsheets/d/${chatlogSheetId}`
    : 'Not configured';
  const body = `
New chatbot booking/payment incident detected.

Session ID: ${incident.session_id}
Session started: ${incident.session_created || 'Not recorded'}
Transcript (Chatlog Sheet, filter by Session ID): ${chatlogLink}

Date: ${incident.date}
Issue Type: ${incident.issue_type}
Name: ${incident.name || 'Not provided'}
Email: ${incident.email || 'Not provided'}
Phone: ${incident.phone || 'Not provided'}
Location Mentioned: ${incident.location || 'Not provided'}
User Message:
${incident.user_message}

SLA Shared With Guest: 48 hours
Fastest Path Shared With Guest: Call (888) 677-0055
`.trim();
```

If `sendSupportIncidentEmail` is not exported, add it so the test can import it.

- [ ] **Step 4: Pass `session_created` into the incident object at the trigger**

In `src/app/api/chat/message/route.js:835-844`, add the field (value already computed at `:772`):

```js
            const incident = {
                  date: new Date().toISOString(),
                  session_id: sessionId,
                  session_created: sessionCreated,
                  issue_type: 'booking_payment_issue',
                  name: extractName(sanitizedMessage),
                  email: extractEmail(sanitizedMessage),
                  phone: extractPhone(sanitizedMessage),
                  location: extractLocation(sanitizedMessage),
                  user_message: sanitizedMessage,
            };
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run __tests__/notify.test.js -t "incident email identifiers"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/notify.js src/app/api/chat/message/route.js __tests__/notify.test.js
git commit -m "feat(chatbot): add session id, start time, and chatlog link to incident emails"
```

---

### Task 5: Full verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: PASS, no previously green test regresses. Baseline before this work is 751 passing / 3 skipped; expect that plus the new tests.

- [ ] **Step 2: Confirm no em dashes were introduced**

Run: `git diff main...HEAD | grep -n "—" || echo "no em dashes"`
Expected: `no em dashes`.

- [ ] **Step 3: Confirm scope**

Run: `git diff main...HEAD --stat`
Expected: only `src/lib/notify.js`, `src/lib/sms-metrics.js`, `src/app/api/cron/sms-upgrade-scan/route.js`, `src/app/api/cron/sms-health-check/route.js`, `src/app/api/chat/message/route.js`, and their tests. No change to candidate selection, sending logic, apply/verify internals, the add-on builder, the twilio webhook, or env removal.

---

## Self-Review

**Spec coverage:**
- Silence healthy runs: Task 2 trigger `errors >= 2 || addonSends >= 1`; one http_500 stays silent, and sent>0 with one error stays silent. Covered (Task 1 tests including the sent>0,errors=1 case).
- Alert (a) 2+ errors: Task 1 classifier + Task 2 wiring. Covered.
- Alert (b) daily zero-send, always fire, copy softened by candidates: Task 3. Covered.
- Alert (d) add-on send (sent only; queued confirmed unreachable/unclassifiable): Task 1 `tallyRunSummary` + Task 2. Covered.
- No daily summary email: nothing adds one. Covered.
- Plain verdict first, JSON last: `formatOpsAlert` guarantees order; asserted. Covered.
- Richa's identifiers using only existing fields: Task 4. Covered; Clarity excluded as nonexistent.
- Tests for healthy=no email (incl. sent>0,errors=1), 2-error=email, addon=email, zero-send always emails: Tasks 1 and 3. Covered.
- Full suite green: Task 5. Covered.

**Placeholder scan:** The metrics test bodies in Task 3 Step 1 are described, not fully written, because they must mirror this file's existing Redis mock; the assertions (INCRBY by N, expire on first write, GET round-trip) are specified exactly. Every other step has complete code.

**Type consistency:** `tallyRunSummary` returns the summary object consumed by `classifyUpgradeScanRun` and `buildUpgradeScanAlert`; `summary.addonSends` is produced in Task 1 and read in Task 1/2. `formatOpsAlert({verdict, whatToDo, technical})` is used by both `buildUpgradeScanAlert` and `buildDailyZeroSendAlert`. `incrementDailyCandidateCount(by, when)` / `getDailyCandidateCount(dateStr)` match their call sites. Incident field is `session_created` consistently.

## Example alert outputs (first line is the verdict)

- (a) errors: `Needs attention: the upgrade scan hit 3 errors in a single run. A healthy run absorbs at most one transient hiccup, so this one needs an engineer to look.`
- (d) add-on breach: `Needs attention: an add-on offer was actually texted to a member (1 this run). Add-on texts are supposed to be impossible from this pipeline, so the safeguard may have broken. Please have engineering check immediately.`
- (b) zero-send, candidates existed: `Needs attention: no upgrade texts went out yesterday (2026-06-07) even though 42 eligible members were scanned. 0 send(s) recorded, below the threshold of 1.`
- (b) zero-send, no candidates: `Heads up: no upgrade texts went out yesterday (2026-06-07), and 0 eligible members were scanned. This may be a genuinely quiet day, so verify the scan is running before treating it as an outage.`

## What already exists (reused, not rebuilt)

- `sms-metrics.js` daily send counter and `sms-health-check` cron: reused; the candidate counter mirrors the send counter.
- The Redis NX dedup pattern: reused, refined to per-condition keys.
- `sendOpsAlertEmail` and its EMAIL_OPS_ALERTS routing: reused unchanged.
- `offerKind` on the downstream result (`pre-appointment/route.js:1131`): reused via a read-only passthrough.

## NOT in scope (considered and deferred)

- **Condition (c), upgrade_verification_failed alert: removed from this PR.** It lives in the apply/verify YES-reply handlers (`chat/message/route.js:900`, `twilio/webhook/route.js:756` and `:820`), a different surface and trigger from the cron alert noise, and its webhook session identifiers (`profile.sessionId`) are unverified. It becomes its own follow-up PR that first confirms the available identifiers at both webhook sites, then wires a notify call. Honors the scope lock and the one-fix-per-PR rule.
- Changing the cron sending logic, candidate selection, the apply/verify internals, the add-on offer builder, or PR C env removal.
- Adding retries to `checkOneCandidate` (would change run behavior).
- A Clarity deep link (no integration exists; the Chatlog Sheet link is the available substitute).
- Per-condition recipient routing (all alerts continue to `sendOpsAlertEmail` -> EMAIL_OPS_ALERTS with the matt@ fallback; incident emails continue to EMAIL_QA_ALERT).
- Counting `status:'queued'` as an add-on send (Q5: unreachable from the in-window cron and structurally unclassifiable).

## Parallelization

Largely sequential: Tasks 1, 2, 3 all touch `notify.js` and the two crons. Task 4 (incident email) also edits `notify.js`, so it shares that file. Run sequentially in one branch. The deferred condition (c) is the natural independent follow-up PR.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | not required (internal alert behavior) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | not run | optional |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_resolved | 5 findings: 1 P1 + 1 P2 resolved via revision; 3 refinements folded in; 0 open |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | n/a (no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | n/a |

Findings and resolutions (first review pass -> revised plan):
- **[P1] condition (b) self-defeating guard** (confidence 9/10): a `candidates > 0` gate would suppress the daily zero-send alert during a broken, disabled, or dead scan (the scan records zero candidates before it processes, so the gate hides the exact outage the check exists to catch). RESOLVED: the daily check always fires on `sends < threshold`; the candidate count only softens the wording (`candidates=0` -> "may be a quiet day, verify"; `candidates>0` -> "eligible members got nothing"). Never gates the email.
- **[P2] condition (c) scope-lock break** (confidence 8/10) and **unverified webhook identifiers** (confidence 6/10): `upgrade_verification_failed` lives in the apply/verify YES-reply handlers, a different surface from the cron alert noise, and `profile.sessionId` on the SMS webhook path is unverified. RESOLVED: condition (c) removed from this PR and moved to NOT-in-scope as a follow-up that verifies identifiers first.
- **[P3] refinements folded in**: (1) added the `sent>0, errors=1` silence test, the exact over-firing shape being fixed; (2) extracted `tallyRunSummary(results)` as a pure, unit-tested function so `addonSends`/`errors` are tested directly; (3) confirmed condition (d) counts add-ons on `sent` only because the in-window cron never returns `queued` and a queued row carries no `offerKind` (Q5); (4) centralized the two alert builders behind `formatOpsAlert({verdict, whatToDo, technical})` for consistent, testable copy.

- **UNRESOLVED:** none. Two minor residuals are by-design consequences of accepted decisions (count-based classifier silences a single non-transient error per run; the daily check sends one soft note on a genuinely quiet day), both documented.
- **VERDICT:** ENG CLEARED. Scope is a/b/d only (cron + notify), one cohesive concern; the P1 and the scope-split are resolved with no open P1/P2. Ready to implement when you are. Do NOT build yet (per instruction).
