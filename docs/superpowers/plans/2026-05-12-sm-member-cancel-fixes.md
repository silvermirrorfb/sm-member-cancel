# sm-member-cancel — Fix the Open Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make outbound upgrade SMS actually send in production, add the detection/monitoring that would have caught the April outage, and ship the cancel-bot fixes that don't need a Travis policy decision.

**Architecture:** Three independent tracks, each shippable on its own and as its own PR (this repo enforces one-fix-per-PR — see `CLAUDE.md` "Scope-lock for PRs"). Track 1 rewires the `sms-upgrade-scan` cron from random-registry-sampling (which produces ~0 sends because a random member rarely has an imminent appointment) to per-location appointment discovery (which empirically returns real appointments and real offers — verified live 2026-05-12: Bryant Park returned 22 appointments / 24h, 1 would-send). Track 2 adds a per-send counter, a daily zero-send alert cron, and Sentry. Track 3 hardens two cancel-bot code paths. Nothing here touches the 10 decisions parked with Travis.

**Tech Stack:** Next.js 16 (App Router), Vercel cron, Upstash Redis, Boulevard GraphQL, Klaviyo, Twilio, Nodemailer, Vitest. Deploys on push to `main` (silver-mirror-projects Vercel team, ~30s).

**Branching:** Each phase below = one branch + one PR. Branch names suggested per phase. Always run `npm test` before opening a PR. Update `QA_ISSUES.md` in the same PR per its "Update protocol" section.

**Pre-read before starting any task:** `CLAUDE.md`, `QA_ISSUES.md`, and `docs/cancel-bot-system-and-issues.md` / `docs/outbound-sms-system-and-issues.md` at the repo root.

**Root-cause summary (from the 2026-05-12 investigation, full report in this session's transcript):**
- The `sms-upgrade-scan` cron builds candidates by randomly sampling 30 of ~6,394 registry members per run. Probed 6 random members → all 6 returned `no_appointments_available`. Expected: a random member almost never has a booking in the next 24h.
- The `locations[]` discovery path inside `/api/sms/automation/pre-appointment` (which calls `scanAppointments` per location) IS functional and PR #3 (`631a0e1`) fixed its client-field selection. The cron just doesn't use it — it was switched away in commit `3606088` (2026-04-08). That switch, not the PR #3 client-fields bug, is the practical cause of the zero-sends symptom.
- Config gates were all open the whole time: `SMS_CRON_ENABLED=true`, `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=false`, `SMS_UPGRADE_STATUS=live`, `SMS_REQUIRE_KLAVIYO_OPT_IN=true`, all 10 locations in `SMS_CRON_LOCATIONS`. The Redis registry is healthy (6,394 members, valid data). `lookupMember` works.
- Funnel observed on the Bryant Park discovery probe (22 appointments / 24h): 8 `member_not_found`, 4 `klaviyo_sms_not_subscribed`, 3 `addon_already_on_booking`, 3 `no_upcoming_appointment_in_window`, 3 `appointment_scan_failed` (likely Boulevard rate-limit under burst), 1 would-send.

---

## File Map

| File | Track | What changes |
|---|---|---|
| `src/app/api/cron/sms-upgrade-scan/route.js` | 1 | Build candidates from per-location `scanAppointments` (rotating subset of locations) instead of random registry members. Add `skippedByReason` histogram + `console.log` of the summary. |
| `src/lib/boulevard.js` (`scanAppointments`, ~line 1765) | 1 | Retry transient failures (HTTP 429 / network) with exponential backoff before returning `{ appointments: null }`. |
| `__tests__/sms-upgrade-scan-route.test.js` | 1 | New: cover the discovery candidate-building and the skip-reason histogram with a mocked `scanAppointments` and a mocked `fetch` to pre-appointment. |
| `__tests__/boulevard.test.js` | 1 | Add cases for `scanAppointments` retry behavior. |
| `src/lib/sms-metrics.js` | 2 | New: `incrementDailySendCount()` / `getDailySendCount(dateStr)` backed by Redis `INCR` + TTL. |
| `src/app/api/sms/automation/pre-appointment/route.js` (~line 1093, after a `sent` result is pushed) | 2 | Call `incrementDailySendCount()` once per actual send. |
| `src/app/api/cron/sms-health-check/route.js` | 2 | New cron: read yesterday's send count, email `memberships@` (via `notify.js` incident-email helper) if below `SMS_MIN_DAILY_SENDS` threshold. |
| `vercel.json` | 2 | Register the new `sms-health-check` cron (`0 14 * * *` = ~9 AM ET). |
| `__tests__/sms-metrics.test.js`, `__tests__/sms-health-check-route.test.js` | 2 | New tests. |
| `sentry.server.config.js`, `instrumentation.ts`, `instrumentation-client.ts` | 2 | New: Sentry init for Next 16 App Router (server + client + edge). |
| `next.config.js` | 2 | Wrap export with `withSentryConfig`. |
| `package.json` | 2 | Add `@sentry/nextjs`. |
| `src/lib/system-prompt.txt` | 3 | Add an explicit guardrail forbidding claims of escalation to systems that don't exist ("QA team", "flagged as urgent", "alerted X"). Do NOT touch the memberships-handoff or 48-hour language (that's Travis Decision 3 territory). |
| `__tests__/claude.test.js` (or a new `__tests__/system-prompt-guardrails.test.js`) | 3 | Assert the guardrail string is present in the built system prompt. |
| `src/lib/member-draft.js` (`pickTemplate`, lines ~80-206) | 3 | Anchor the loose reason-matching regexes (`transit`, `far`, `left`, `value`, `worth`, …) with word boundaries so a substring like `transitions` no longer false-matches `transit`. |
| `__tests__/member-draft.test.js` | 3 | Regression test: a CANCELLED summary with `reason_primary = "Missing milestone rewards due to multiple account TRANSITIONS"` must NOT pick the location/transit template. |

---

# TRACK 1 — Outbound SMS sends near-zero

Branch: `fix/sms-cron-uses-appointment-discovery`. Closes outbound-sms #8 verification with a real fix; addresses the practical cause behind the "outage" narrative in outbound-sms #6/#7.

## Task 1.1: Read the surrounding code

- [ ] **Step 1: Read these in full before editing**

```
src/app/api/cron/sms-upgrade-scan/route.js          (179 lines — the cron you're rewriting)
src/app/api/sms/automation/pre-appointment/route.js  (lines 279-433 — resolveCandidates, toLocationCandidate, the discovery block, the candidate filter at ~423)
src/lib/boulevard.js                                 (scanAppointments at ~1765-1870; evaluateUpgradeOpportunityForProfile at ~2233-2330; note scanAppointments accepts { locationId, clientId, windowStart, windowEnd } and returns { appointments, diagnostics } where appointments is an array, [], or null)
src/lib/sms-member-registry.js                       (getRegistryCounts — you'll keep using this for the response payload)
```

Note: `scanAppointments({ locationId, windowStart, windowEnd })` with NO `clientId` returns ALL appointments at that location in the window, each with `clientFirstName`, `clientLastName`, `clientEmail`, `clientPhone`, `clientId`, `id` (appointment id), `locationId`, `startOn` — verified live 2026-05-12 returning 22 rows for Bryant Park / 24h, populated post-PR-#3. The cron's existing parallel-batch-of-5 sender (`checkOneCandidate` + the batched `for` loop) stays exactly as-is; only the candidate source changes.

## Task 1.2: Discovery-based candidate building in the cron

**Files:**
- Modify: `src/app/api/cron/sms-upgrade-scan/route.js`
- Test: `__tests__/sms-upgrade-scan-route.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `__tests__/sms-upgrade-scan-route.test.js`. Mock `../src/lib/boulevard` so `scanAppointments` returns a fixed list of 3 appointments for one location and `[]` for the others; mock `getBoulevardAuthContext` to return `{ apiUrl: 'x', headers: {} }`; mock `globalThis.fetch` so the POST to `/api/sms/automation/pre-appointment` returns `{ results: [{ status: 'sent' }, { status: 'skipped', reason: 'klaviyo_sms_not_subscribed' }, { status: 'skipped', reason: 'member_not_found' }] }`. Set env: `CRON_SECRET` empty (so `isCronAuthorized` passes in test/`NODE_ENV!==production`), `SMS_CRON_ENABLED=true`, `SMS_CRON_LOCATIONS='Bryant Park,Flatiron'`, and force the send window open by mocking `../src/lib/sms-window` `isWithinSendWindow` → `{ allowed: true }`.

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const scanAppointments = vi.fn();
const getBoulevardAuthContext = vi.fn(() => ({ apiUrl: 'https://blvd.test', headers: {} }));
vi.mock('../src/lib/boulevard', () => ({
  scanAppointments,
  getBoulevardAuthContext,
  canonicalizeBoulevardLocationId: (x) => x,
  resolveBoulevardLocationInput: (x) => ({ locationId: x, canonicalId: x, locationName: x }),
}));
vi.mock('../src/lib/sms-window', () => ({
  isWithinSendWindow: () => ({ allowed: true, timeZone: 'America/New_York', hour: 13, startHour: 9, endHour: 19 }),
  getNextWindowStartIso: () => new Date().toISOString(),
}));
vi.mock('../src/lib/sms-member-registry', () => ({
  getRegistryCounts: vi.fn(async () => ({})),
}));

describe('sms-upgrade-scan cron (discovery mode)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = '';
    process.env.SMS_CRON_ENABLED = 'true';
    process.env.SMS_CRON_LOCATIONS = 'Bryant Park,Flatiron';
    scanAppointments.mockReset();
    scanAppointments.mockImplementation(async (_url, _h, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return { appointments: [
          { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@x.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: new Date(Date.now() + 2*3600*1000).toISOString() },
          { id: 'a2', clientId: 'c2', clientFirstName: 'Sam', clientLastName: 'Park', clientEmail: '', clientPhone: '+15553334444', locationId: 'Bryant Park', startOn: new Date(Date.now() + 5*3600*1000).toISOString() },
          { id: 'a3', clientId: '', clientFirstName: '', clientLastName: '', clientEmail: '', clientPhone: '', locationId: 'Bryant Park', startOn: new Date(Date.now() + 6*3600*1000).toISOString() },
        ] };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ results: [{ status: 'sent' }, { status: 'skipped', reason: 'klaviyo_sms_not_subscribed' }] }) }));
  });

  it('builds candidates from scanned appointments, drops ones missing name/contact, and reports skippedByReason', async () => {
    const { GET } = await import('../src/app/api/cron/sms-upgrade-scan/route.js');
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    // a3 had no name/contact → never sent to pre-appointment
    expect(body.candidateCount).toBe(2);
    expect(body.summary.sent).toBeGreaterThanOrEqual(1);
    expect(body.summary).toHaveProperty('skippedByReason');
    expect(body.summary.skippedByReason).toHaveProperty('klaviyo_sms_not_subscribed');
    // discovery mode means scanAppointments was actually called per targeted location
    expect(scanAppointments).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/sms-upgrade-scan-route.test.js`
Expected: FAIL — current cron has no `candidateCount`/`skippedByReason`, doesn't call `scanAppointments`, and reads the registry instead.

- [ ] **Step 3: Rewrite the cron's candidate-building section**

In `src/app/api/cron/sms-upgrade-scan/route.js`:
1. Add to the imports from `'../../../../lib/boulevard'`: `getBoulevardAuthContext, scanAppointments`.
2. Add env-driven knobs near the top:

```javascript
const DISCOVERY_WINDOW_HOURS = Number(process.env.SMS_CRON_DISCOVERY_WINDOW_HOURS || 24);
const LOCATIONS_PER_RUN = Math.max(1, Number(process.env.SMS_CRON_LOCATIONS_PER_RUN || 2));
const MAX_CANDIDATES_PER_RUN = Math.max(1, Number(process.env.SMS_CRON_MAX_CANDIDATES || 40));
```

3. Replace the registry-read + shuffle + `candidates` block (current lines ~114-139) with: pick a rotating subset of the target locations, scan each for upcoming appointments, build candidates from the appointments. Keep `CANDIDATES_PER_RUN`/`PARALLEL_BATCH`/`BATCH_DELAY_MS` and the existing batched `for` loop unchanged below it.

```javascript
const targetLocationIds = [...targetLocationMap.keys()];
// Round-robin through locations so every location is covered across runs.
const rotIndex = Math.floor(Date.now() / (10 * 60 * 1000)) % Math.max(1, Math.ceil(targetLocationIds.length / LOCATIONS_PER_RUN));
const runLocationIds = targetLocationIds.slice(rotIndex * LOCATIONS_PER_RUN, rotIndex * LOCATIONS_PER_RUN + LOCATIONS_PER_RUN);
const registryCounts = await getRegistryCounts(targetLocationIds); // kept for the response payload only

const auth = getBoulevardAuthContext();
if (!auth) {
  return NextResponse.json({ error: 'Boulevard not configured' }, { status: 500 });
}
const nowMs = Date.now();
const cutoffMs = nowMs + DISCOVERY_WINDOW_HOURS * 60 * 60 * 1000;
const seen = new Set();
const candidates = [];
for (const locId of runLocationIds) {
  let scan = null;
  try {
    scan = await scanAppointments(auth.apiUrl, auth.headers, {
      locationId: locId,
      windowStart: new Date(nowMs - 30 * 60 * 1000),
      windowEnd: new Date(cutoffMs),
    });
  } catch (e) {
    continue; // a single location's scan failing should not abort the run
  }
  const appts = Array.isArray(scan?.appointments) ? scan.appointments : [];
  for (const a of appts) {
    const startMs = new Date(a?.startOn || '').getTime();
    if (!Number.isFinite(startMs) || startMs < nowMs || startMs > cutoffMs) continue;
    const firstName = String(a?.clientFirstName || '').trim();
    const lastName = String(a?.clientLastName || '').trim();
    const email = String(a?.clientEmail || '').trim().toLowerCase();
    const phone = String(a?.clientPhone || '').trim();
    if (!firstName || !lastName || (!email && !phone)) continue; // mirrors pre-appointment's discovery filter
    const dedup = a?.clientId ? `c:${a.clientId}` : phone ? `p:${phone.replace(/\D/g, '')}` : `e:${email}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    candidates.push({
      clientId: String(a?.clientId || ''),
      firstName, lastName, email, phone,
      appointmentId: String(a?.id || ''),
      locationName: targetLocationMap.get(locId) || '',
    });
    if (candidates.length >= MAX_CANDIDATES_PER_RUN) break;
  }
  if (candidates.length >= MAX_CANDIDATES_PER_RUN) break;
}

if (candidates.length === 0) {
  return NextResponse.json({ ok: true, skipped: 'no_appointments_in_window', registryCounts, runLocations: runLocationIds });
}
```

4. The batched sender below stays the same — but it already passes `candidates: [candidate]` to pre-appointment; the candidate object now includes `appointmentId`, which `evaluateUpgradeOpportunityForProfile` uses to evaluate that specific booking.

- [ ] **Step 4: Add the skip-reason histogram + log to the response**

Replace the final `summary` construction in the cron (currently `{ total, sent, skipped, errors }`) with one that also tallies reasons, and `console.log` it so it shows in Vercel runtime logs (the route currently logs nothing):

```javascript
const summary = { total: allResults.length, sent: 0, skipped: 0, errors: 0, skippedByReason: {} };
for (const val of allResults) {
  if (val.status === 'sent') summary.sent++;
  else if (val.status === 'error' || !val.ok) summary.errors++;
  else {
    summary.skipped++;
    const r = val.reason || 'unknown';
    summary.skippedByReason[r] = (summary.skippedByReason[r] || 0) + 1;
  }
}
console.log('[sms-upgrade-scan]', JSON.stringify({ runLocations: runLocationIds, candidateCount: candidates.length, summary }));

return NextResponse.json({
  ok: true,
  registryCounts,
  runLocations: runLocationIds,
  candidateCount: candidates.length,
  summary,
  results: allResults,
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run __tests__/sms-upgrade-scan-route.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass. If `sms-automation-route.test.js` or similar references the old cron shape, update those expectations (the cron's public response gained `candidateCount`/`runLocations` and `summary.skippedByReason`; it no longer returns `summary` shape `{total,sent,skipped,errors}` only).

- [ ] **Step 7: Update QA_ISSUES.md**

Mark outbound-sms #8 `VERIFIED FIXED (PR #N)` with a one-line note: "cron now builds candidates from per-location appointment discovery (scanAppointments), not random registry sampling; `summary.skippedByReason` added; coverage rotates all 10 locations across runs." Add a new cross-cutting note that the practical cause of the zero-sends symptom was commit `3606088` (registry-random switch), not the PR #3 client-fields bug. Update the "Last updated" date.

- [ ] **Step 8: Commit & PR**

```bash
git checkout -b fix/sms-cron-uses-appointment-discovery
git add src/app/api/cron/sms-upgrade-scan/route.js __tests__/sms-upgrade-scan-route.test.js QA_ISSUES.md
git commit -m "fix(sms): build cron candidates from per-location appointment discovery, not random registry sampling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin fix/sms-cron-uses-appointment-discovery
gh pr create --fill
```

- [ ] **Step 9: Post-deploy verification (do this, do not skip)**

After merge + deploy, between 9 AM and 7 PM ET: `vercel logs sm-member-cancel.vercel.app --scope silver-mirror-projects` and watch for a `[sms-upgrade-scan]` line, OR re-run the read-only Redis check from the investigation — `SCAN 0 MATCH sms-cooldown:* COUNT 1000` against Upstash; any keys present = a real send happened in the last 6h. If `summary.sent` stays 0 across many in-window runs AND `summary.skippedByReason` is dominated by `member_not_found` or `klaviyo_sms_not_subscribed`, that's a data/consent issue (not this fix) — note it as a new QA_ISSUES item.

## Task 1.3: Retry transient Boulevard failures in scanAppointments

**Files:**
- Modify: `src/lib/boulevard.js` (`scanAppointments`, ~line 1765-1870, and any internal `fetch` it does)
- Test: `__tests__/boulevard.test.js`

- [ ] **Step 1: Read `scanAppointments` and find every place it returns `{ appointments: null, diagnostics }`** — those are the failure exits (HTTP non-2xx, GraphQL errors, fetch throw). Identify the inner `fetch(apiUrl, …)` call(s).

- [ ] **Step 2: Write the failing test**

In `__tests__/boulevard.test.js`, add a case: mock `fetch` to reject with a network error twice then resolve successfully on the third call; assert `scanAppointments` returns the appointments array (i.e., it retried) and that `fetch` was called 3 times. Add a second case: mock `fetch` to return `{ ok: false, status: 429 }` twice then a 200 with data; assert the same. Add a third: `fetch` always 500 → after the retry budget, returns `{ appointments: null }` with `diagnostics.status === 500`.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run __tests__/boulevard.test.js -t scanAppointments`
Expected: FAIL — no retry today.

- [ ] **Step 4: Implement a small retry helper and wrap the fetch**

Add near the top of `boulevard.js` (or reuse one if it already exists — check first):

```javascript
async function fetchWithRetry(url, init, { attempts = 3, baseDelayMs = 400 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || (res.status >= 400 && res.status < 429) || res.status === 401 || res.status === 403) return res;
      // 429 / 5xx → retryable
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
  }
  if (lastErr) throw lastErr; // caller already wraps in try/catch and returns { appointments: null }
}
```

Then change `scanAppointments`'s inner `fetch(apiUrl, …)` to `fetchWithRetry(apiUrl, …)`. Keep the existing try/catch that converts a throw into `{ appointments: null, diagnostics }`. Do NOT change `scanAppointments`'s signature or return shape.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/boulevard.test.js -t scanAppointments` then `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit & PR** (separate PR from Task 1.2 — one fix per PR)

```bash
git checkout -b fix/boulevard-scan-retry
git add src/lib/boulevard.js __tests__/boulevard.test.js
git commit -m "fix(boulevard): retry transient scanAppointments failures (429/5xx/network) with backoff

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin fix/boulevard-scan-retry
gh pr create --fill
```

---

# TRACK 2 — Detection & monitoring (so the next outage is caught in 24h, not 3 weeks)

## Task 2.1: Per-send counter

Branch: `feat/sms-daily-send-counter`.

**Files:**
- Create: `src/lib/sms-metrics.js`
- Modify: `src/app/api/sms/automation/pre-appointment/route.js` (right after a `status: 'sent'` result is pushed, ~line 1093)
- Test: `__tests__/sms-metrics.test.js`

- [ ] **Step 1: Write the failing test**

`__tests__/sms-metrics.test.js`: mock `@upstash/redis` so `Redis` is a class with `incr`, `expire`, `get` spies; set `UPSTASH_REDIS_REST_URL`/`_TOKEN`; call `incrementDailySendCount()` and assert it called `incr('sms-sent:' + <today YYYY-MM-DD in America/New_York>)` and `expire(..., <~3 days>)`; call `getDailySendCount('2026-05-11')` and assert it called `get('sms-sent:2026-05-11')` and returned the number. Add a case: no Redis env → `incrementDailySendCount()` is a no-op that returns `false`, `getDailySendCount()` returns `0`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/sms-metrics.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/sms-metrics.js`**

```javascript
import { Redis } from '@upstash/redis';

const SENT_KEY_PREFIX = 'sms-sent:';
const SENT_TTL_SECONDS = 3 * 24 * 60 * 60; // keep ~3 days of daily counters
const METRICS_TZ = process.env.SMS_OUTBOUND_TIMEZONE || 'America/New_York';

let cachedRedis = null;
let cachedSig = '';
function getRedis() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  const sig = `${url}|${token}`;
  if (cachedRedis && cachedSig === sig) return cachedRedis;
  cachedRedis = new Redis({ url, token });
  cachedSig = sig;
  return cachedRedis;
}

export function localDateStr(d = new Date(), timeZone = METRICS_TZ) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function incrementDailySendCount(when = new Date()) {
  const redis = getRedis();
  if (!redis) return false;
  const key = `${SENT_KEY_PREFIX}${localDateStr(when)}`;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, SENT_TTL_SECONDS);
    return true;
  } catch (e) {
    console.warn('[sms-metrics] incr failed:', e.message);
    return false;
  }
}

export async function getDailySendCount(dateStr) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get(`${SENT_KEY_PREFIX}${dateStr}`);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.warn('[sms-metrics] get failed:', e.message);
    return 0;
  }
}
```

- [ ] **Step 4: Wire it into the send path**

In `src/app/api/sms/automation/pre-appointment/route.js`, add `import { incrementDailySendCount } from '../../../../../lib/sms-metrics';` and, immediately after `sentCount += 1;` (right before the `results.push({ ... status: 'sent' ... })`), add `await incrementDailySendCount();`. (One increment per real Twilio send. The dryRun branch above already `continue`s before this, so dry runs don't count.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run __tests__/sms-metrics.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit & PR**

```bash
git checkout -b feat/sms-daily-send-counter
git add src/lib/sms-metrics.js src/app/api/sms/automation/pre-appointment/route.js __tests__/sms-metrics.test.js
git commit -m "feat(sms): track daily outbound send count in Redis

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin feat/sms-daily-send-counter
gh pr create --fill
```

## Task 2.2: Zero-send alert cron

Branch: `feat/sms-zero-send-alert`. Depends on Task 2.1 being merged.

**Files:**
- Create: `src/app/api/cron/sms-health-check/route.js`
- Modify: `vercel.json`
- Test: `__tests__/sms-health-check-route.test.js`
- Pre-read: `src/lib/notify.js` lines ~255-300 (`sendSupportIncidentEmail`) — reuse it for the alert email; if its signature doesn't fit a generic alert, add a tiny `sendOpsAlertEmail({ subject, text })` helper to `notify.js` that builds a nodemailer transport the same way and sends to `process.env.EMAIL_ESCALATION || process.env.EMAIL_TO`.

- [ ] **Step 1: Write the failing test**

`__tests__/sms-health-check-route.test.js`: mock `../src/lib/sms-metrics` (`getDailySendCount`, `localDateStr`) and `../src/lib/notify` (the alert email helper). Case A: `getDailySendCount` returns 0 for yesterday, `SMS_MIN_DAILY_SENDS` unset (default e.g. 1) → route returns `{ ok: true, alerted: true, yesterdaySends: 0 }` and the email helper was called once with a subject containing "zero outbound SMS" and the date. Case B: returns 12 → `{ ok: true, alerted: false, yesterdaySends: 12 }`, email NOT called. Case C: `SMS_CRON_ENABLED` falsy → `{ ok: true, skipped: 'SMS_CRON_ENABLED is false' }`, no email. Case D: bad/missing `CRON_SECRET` auth in production → 401 (mirror the existing cron auth pattern).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/sms-health-check-route.test.js`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the route**

```javascript
import { NextResponse } from 'next/server';
import { getDailySendCount, localDateStr } from '../../../../lib/sms-metrics';
import { sendOpsAlertEmail } from '../../../../lib/notify'; // or sendSupportIncidentEmail — match notify.js

function isCronAuthorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const h = String(request.headers.get('authorization') || '').trim();
  return h.toLowerCase().startsWith('bearer ') && h.slice(7).trim() === secret;
}

export async function GET(request) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const enabled = String(process.env.SMS_CRON_ENABLED || '').toLowerCase();
  if (enabled !== 'true' && enabled !== '1') return NextResponse.json({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });

  const threshold = Math.max(0, Number(process.env.SMS_MIN_DAILY_SENDS || 1));
  // "yesterday" in the metrics timezone
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = localDateStr(yesterday);
  const sends = await getDailySendCount(dateStr);

  if (sends < threshold) {
    await sendOpsAlertEmail({
      subject: `[Silver Mirror] zero outbound SMS on ${dateStr} (count ${sends}, threshold ${threshold})`,
      text: `The pre-appointment SMS pipeline sent ${sends} message(s) on ${dateStr}, below the alert threshold of ${threshold}.\n\nCheck: (1) Vercel cron logs for "[sms-upgrade-scan]" and its summary.skippedByReason, (2) the Redis registry counts (HLEN sms-registry:loc:*), (3) SMS_CRON_ENABLED / SMS_REQUIRE_MANUAL_LIVE_APPROVAL / SMS_UPGRADE_STATUS env values, (4) Boulevard auth.\n\nSee docs/outbound-sms-system-and-issues.md and QA_ISSUES.md (outbound-sms section).`,
    });
    return NextResponse.json({ ok: true, alerted: true, yesterdaySends: sends, threshold, date: dateStr });
  }
  return NextResponse.json({ ok: true, alerted: false, yesterdaySends: sends, threshold, date: dateStr });
}
```

- [ ] **Step 4: Register the cron in `vercel.json`** — add to the `crons` array:

```json
{ "path": "/api/cron/sms-health-check", "schedule": "0 14 * * *" }
```

(14:00 UTC ≈ 9–10 AM ET — runs after the previous day's send window has fully closed.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run __tests__/sms-health-check-route.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 6: Update QA_ISSUES.md** — mark cross-cutting #1 (no zero-send alerting) as `VERIFIED FIXED (PR #N)`, note threshold env `SMS_MIN_DAILY_SENDS`.

- [ ] **Step 7: Commit & PR**

```bash
git checkout -b feat/sms-zero-send-alert
git add src/app/api/cron/sms-health-check/route.js src/lib/notify.js vercel.json __tests__/sms-health-check-route.test.js QA_ISSUES.md
git commit -m "feat(sms): daily zero-send alert cron (emails ops if yesterday's sends below threshold)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin feat/sms-zero-send-alert
gh pr create --fill
```

## Task 2.3: Sentry error monitoring

Branch: `feat/sentry`. **Manual prerequisite (Matt or whoever owns Vercel):** create a Sentry project for this app, copy its DSN, and run `vercel env add SENTRY_DSN production` (also `preview`, `development`) and `vercel env add SENTRY_AUTH_TOKEN production` (for source-map upload — optional). After adding env vars, redeploy (`vercel --prod --yes`) — env changes don't take effect until a deploy (see `MEMORY.md` "Vercel env changes require explicit redeploy").

**Files:**
- Create: `sentry.server.config.js`, `instrumentation.ts`, `instrumentation-client.ts`
- Modify: `next.config.js`, `package.json`
- (no new test — Sentry init is config; verify via a deliberate test error after deploy)

- [ ] **Step 1: Install**

Run: `npm install --save @sentry/nextjs` (this also adds it to `package.json` dependencies; commit `package.json` and `package-lock.json`).

- [ ] **Step 2: Add config files** (Next 16 App Router layout)

`sentry.server.config.js`:
```javascript
import * as Sentry from '@sentry/nextjs';
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: Boolean(process.env.SENTRY_DSN),
});
```

`instrumentation-client.ts`:
```typescript
import * as Sentry from '@sentry/nextjs';
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,
  tracesSampleRate: 0.05,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN),
});
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
```

`instrumentation.ts`:
```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.server.config'); // same minimal init works for the edge runtime
  }
}
export async function onRequestError(...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>) {
  const { captureRequestError } = await import('@sentry/nextjs');
  return captureRequestError(...args);
}
```

- [ ] **Step 3: Wrap `next.config.js`**

Change the bottom of `next.config.js` from `module.exports = nextConfig;` to:

```javascript
const { withSentryConfig } = require('@sentry/nextjs');
module.exports = withSentryConfig(nextConfig, {
  silent: true,
  // org/project only needed for source-map upload; safe to omit if SENTRY_AUTH_TOKEN isn't set
  disableLogger: true,
});
```

- [ ] **Step 4: Build locally to confirm nothing broke**

Run: `npm run build`
Expected: build succeeds (Sentry is inert when `SENTRY_DSN` is unset).

- [ ] **Step 5: Commit & PR**

```bash
git checkout -b feat/sentry
git add sentry.server.config.js instrumentation.ts instrumentation-client.ts next.config.js package.json package-lock.json
git commit -m "feat: add Sentry error monitoring (@sentry/nextjs); inert until SENTRY_DSN is set

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin feat/sentry
gh pr create --fill
```

- [ ] **Step 6: After deploy + DSN set** — trigger one deliberate error (e.g., a temporary `/api/_sentry-test` route that throws, hit it once, then revert) and confirm it appears in Sentry. Update `CLAUDE.md` env section: `SENTRY_DSN` is now set. Update `QA_ISSUES.md` cross-cutting (no error monitoring) → resolved.

---

# TRACK 3 — Cancel-bot fixes that need no Travis decision

## Task 3.1: Guardrail against fabricated escalation claims

Branch: `fix/bot-no-fabricated-escalations`. This is the *code* portion of cancel-bot #6 — it does NOT decide what the bot should promise (that's Travis Decision 3); it only forbids the bot from inventing escalation targets that don't exist (the "I've alerted our QA team" / "I'm flagging this as urgent" pattern, which the system prompt does not currently authorize and which maps to no real system).

**Files:**
- Modify: `src/lib/system-prompt.txt`
- Test: add to `__tests__/claude.test.js` (or create `__tests__/system-prompt-guardrails.test.js`)

- [ ] **Step 1: Read `src/lib/system-prompt.txt`** — find a natural place under the membership/cancellation handling section (near the lines about "passing it to the memberships manager/team for backend processing", ~line 227 and ~line 611) to add a hard rule. Note the repo style: no em dashes, cosmetic-only language.

- [ ] **Step 2: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { buildSystemPromptWithProfile } from '../src/lib/claude';

describe('system prompt — fabricated-escalation guardrail', () => {
  it('forbids claiming escalation to systems that do not exist', () => {
    const prompt = buildSystemPromptWithProfile('Test Member profile');
    expect(prompt).toMatch(/do not (claim|say|tell).*alerted.*team/i);
    // and it must not promise a "QA team" anywhere
    expect(prompt.toLowerCase()).not.toContain('qa team');
  });
});
```

(If `buildSystemPromptWithProfile` isn't importable that way, check `src/lib/claude.js` for the right export; the test just needs to assert the guardrail text is in the assembled prompt.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run __tests__/claude.test.js -t guardrail` (or the new file)
Expected: FAIL.

- [ ] **Step 4: Add the guardrail to `system-prompt.txt`**

Add (adjust wording to match the file's voice; no em dashes):

```
HARD RULE — DO NOT INVENT ESCALATION:
- The only real downstream destinations are: (1) the memberships team / manager (handled via the session summary email and the cancellations log), and (2) a manager callback when one is explicitly arranged.
- Never tell a member you have "alerted our QA team", "flagged this as urgent", "escalated to engineering", or notified any other team or system. Those systems do not exist. Saying so is a false promise.
- If a member's issue genuinely needs human follow-up, say only that you are passing it to the memberships team and they will follow up. Do not name a team, department, or timeframe that you cannot guarantee.
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run __tests__/claude.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-check the live bot after deploy** — open the widget on the cancellation page, raise a fake billing complaint, confirm the bot no longer says "I've alerted our QA team" or similar. Update `QA_ISSUES.md` cancel-bot #6: note the code/prompt guardrail shipped (PR #N); the broader "what should the bot promise" question stays AWAITING DECISION (Travis Decision 3).

- [ ] **Step 7: Commit & PR**

```bash
git checkout -b fix/bot-no-fabricated-escalations
git add src/lib/system-prompt.txt __tests__/claude.test.js QA_ISSUES.md
git commit -m "fix(bot): forbid fabricated escalation claims (no 'alerted our QA team') in system prompt

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin fix/bot-no-fabricated-escalations
gh pr create --fill
```

## Task 3.2: Stop loose reason regexes from substring-matching the wrong template

Branch: `fix/template-reason-word-boundaries`. This is the open adjacent vulnerability called out under cancel-bot #9: PR #8 routes REFERRED outcomes first, but RETAINED and CANCELLED outcomes still fall through to `pickTemplate`'s loose reason regexes, where e.g. `/transit/` matches `transitions`, `/far/` matches `farewell`/`affair`, `/left/` matches `leftover`.

**Files:**
- Modify: `src/lib/member-draft.js` (`pickTemplate`, lines ~80-206)
- Test: `__tests__/member-draft.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { pickTemplate } from '../src/lib/member-draft'; // confirm the export name

describe('pickTemplate — reason matching does not catch substrings', () => {
  it('a CANCELLED milestone-rewards reason does not pick a location/transit template', () => {
    const t = pickTemplate({
      outcome: 'CANCELLED',
      reason_primary: 'Missing milestone rewards due to multiple account TRANSITIONS',
      offer_accepted: '',
      location: 'Flatiron',
    });
    expect(t.id).not.toMatch(/location|transit|parking/i);
    // CANCELLED with no specific reason match → generic cancelled
    expect(t.id).toMatch(/generic|cancel/i);
  });

  it('a real transit reason still picks the location template', () => {
    const t = pickTemplate({ outcome: 'CANCELLED', reason_primary: 'public transit is unreliable to this location', offer_accepted: '', location: 'Flatiron' });
    expect(t.id).toMatch(/location|transit/i);
  });
});
```

(Check the actual template `id` strings in `member-draft.js` — e.g. `tmplLocationCancel` returns some `id` like `42-location-cancel` or similar; adjust the assertions to the real ids. If `pickTemplate` isn't exported, export it, or test via the public function that calls it and inspect the returned draft's `id`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/member-draft.test.js -t substrings`
Expected: FAIL — `/transit/` matches `transitions`, so the milestone-rewards reason wrongly resolves to the location template.

- [ ] **Step 3: Anchor the loose regexes**

In `pickTemplate` (and in the CANCELLED and RETAINED branches above it), change the alternations that can false-match substrings to word-boundary-anchored versions. The riskiest are the short tokens; anchor them all consistently:
- `/parking|transit|commute|far/` → `/\bparking\b|\btransit\b|\bcommute\b|\bcommuting\b|\bfar\b/` (used at line ~103 and line ~194 — change both)
- `/turnover|left|departed|quit/` → `/\bturnover\b|\bleft\b|\bdeparted\b|\bquit\b/` (line ~168)
- `/value|worth|not.?worth/` → `/\bvalue\b|\bworth\b|not\s*worth/` (line ~200)
- Review the rest of the alternations in `pickTemplate` for any other bare short word that could appear inside a longer word (`new`, `lead`, `ai`, `pric`, …) — `\b…\b` them where the risk is real; leave intentional prefixes like `reloc`, `inconsist`, `dermatolog` as-is (those are deliberate stem matches and don't false-positive in practice).
- Do NOT change the `isReferred` short-circuit at the top — it's correct.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run __tests__/member-draft.test.js` then `npm test`
Expected: PASS — and the existing `member-draft.test.js` cases still pass (the anchored regexes still match the intended reason strings).

- [ ] **Step 5: Update QA_ISSUES.md** — cancel-bot #9: mark the "adjacent vulnerability still OPEN" note as resolved (PR #N), describe the word-boundary fix.

- [ ] **Step 6: Commit & PR**

```bash
git checkout -b fix/template-reason-word-boundaries
git add src/lib/member-draft.js __tests__/member-draft.test.js QA_ISSUES.md
git commit -m "fix(email): anchor pickTemplate reason regexes so substrings (e.g. 'transitions') don't match 'transit'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin fix/template-reason-word-boundaries
gh pr create --fill
```

---

## Out of scope (intentionally)

- The 10 chatbot-script decisions parked with Travis (`docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`): retention aggressiveness after refusals (#1/#2), what the bot should promise / 48-hour language (#3), perk dollar values (#4), identity verification floor (#5), refund/double-billing script (#6), credit visibility (#7), tone (#8), channel-loop rule (#9), commitment language (#10). These are business/policy calls, not engineering tasks. When Travis decides, each becomes its own small PR.
- Conversational integration tests for the bot (cross-cutting #2) and a staging environment (cross-cutting #5): larger efforts, separate plan.
- The `member_not_found` rate (~36% of Bryant Park appointment-holders couldn't be matched to a Boulevard member): worth investigating after Track 1 ships, but it's a `lookupMember` matching question, not part of this plan. File it as a new QA_ISSUES item if it persists.

## Suggested PR order

1. Track 1, Task 1.3 (`scanAppointments` retry) — small, low-risk, makes Task 1.2 more robust.
2. Track 1, Task 1.2 (cron → discovery) — the headline fix. Verify post-deploy before anything else touches the SMS surface (per `CLAUDE.md` "Verification before next change").
3. Track 2, Task 2.1 → 2.2 (send counter → zero-send alert) — now the system self-reports.
4. Track 3, Task 3.1 and 3.2 — independent of everything above; can go in parallel.
5. Track 2, Task 2.3 (Sentry) — whenever the DSN is provisioned.

## Self-review notes (done)

- Spec coverage: (1) outbound-SMS root cause → Track 1 Tasks 1.2/1.3; (2) zero-send alerting → 2.1/2.2; skip-reason telemetry → 1.2 Step 4; error monitoring → 2.3; (3) substring-matching vuln → 3.2; fabricated "QA team" promise → 3.1; `appointment_scan_failed` flakiness → 1.3. All covered.
- Placeholders: the only non-literal items are (a) the exact template `id` strings in 3.2's test (the implementer must read `member-draft.js` to get them — flagged inline) and (b) the precise insertion points / surrounding-prose match in `system-prompt.txt` for 3.1 — both require reading a specific file, which is a legitimate pre-read, not a hand-wave. The Sentry DSN is a genuine external prerequisite, not a placeholder.
- Type/name consistency: `incrementDailySendCount` / `getDailySendCount` / `localDateStr` used consistently across 2.1 and 2.2. `scanAppointments` signature unchanged. `pickTemplate` export name to be confirmed by the implementer (noted).
