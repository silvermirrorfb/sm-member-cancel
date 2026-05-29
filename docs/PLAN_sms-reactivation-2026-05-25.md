# SMS Reactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reactivate paused SMS pre-appointment upsells (duration upgrades first, then addons) using a diagnostic-first sequence so every code fix is grounded in observed Boulevard responses, not guesses.

**Architecture:** Six sequenced steps. Step 0 verifies prod env gates. Step 1 collects diagnostic data and adds temporary verbose Boulevard logging if Vercel runtime logs are insufficient. Steps 2 and 4 each ship one PR keyed off a contingency branch selected from Step 1 outcomes. Steps 3 and 5 are env-var flips that re-enable the duration and addon paths respectively, each with same-procedure rollback. Step 6 is an optional copy polish if post-flip member behavior shows the existing success reply is too terse.

**Tech Stack:** Next.js 14 App Router on Vercel, Vitest, Boulevard GraphQL, Twilio SMS, Upstash Redis, Klaviyo, Sentry, Node.js runtime.

**Source spec:** `/Users/mattmaroone/.gstack/projects/silvermirrorfb-sm-member-cancel/mattmaroone-main-design-20260525-133413.md`

**Hard rules (CLAUDE.md):**
- One fix per PR
- 244+ Vitest tests stay green at each PR landing
- No destructive Boulevard mutations (prod guard at commit `2937307` stays in place)
- `vercel env add/rm/update` requires `vercel --prod --yes` to take effect at runtime
- Klaviyo owns TCPA gate; do not touch
- Cosmetic-only language, no em dashes, no medical terminology, 10 locations, Hydradermabrasion (never HydraFacial)

---

## Pre-Flight (do once at start of session)

- [ ] **Confirm baseline test suite passes on `main`**

```bash
cd ~/sm-member-cancel
git checkout main
git pull origin main
npm install
npm test
```

Expected: all 244+ Vitest tests pass, exit code 0. If any test fails on clean `main`, stop and investigate before proceeding.

- [ ] **Confirm Vercel CLI is logged in and pointed at the right project**

```bash
vercel whoami
vercel link --yes
```

Expected: `whoami` shows your Vercel username; `link` either confirms the existing project link or relinks to `silver-mirror-projects/sm-member-cancel`.

---

## Step 0: Prerequisite Environment Verification

**Goal:** Confirm the two env flags that gate every step below are in the expected state.

**Files:** None (read-only env inspection).

- [ ] **Step 0.1: List production env vars filtered to the two gates**

```bash
vercel env ls production | grep -E 'BOULEVARD_ENABLE_UPGRADE_MUTATION|SMS_REQUIRE_MANUAL_LIVE_APPROVAL|SMS_CRON_ENABLED'
```

Expected output: three lines, one per var.

- [ ] **Step 0.2: Pull the actual values into a local env file for inspection**

```bash
vercel env pull .env.production.local --environment=production --yes
grep -E 'BOULEVARD_ENABLE_UPGRADE_MUTATION|SMS_REQUIRE_MANUAL_LIVE_APPROVAL|SMS_CRON_ENABLED|BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK' .env.production.local
```

Expected values:
- `BOULEVARD_ENABLE_UPGRADE_MUTATION=true` (REQUIRED — if absent or false, proceed to Step 0.3)
- `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=true` (will be flipped in Step 3)
- `SMS_CRON_ENABLED=false` (will be flipped in Step 3)
- `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK=false` (stays false, this is the destructive-fallback wall)

- [ ] **Step 0.3: If `BOULEVARD_ENABLE_UPGRADE_MUTATION` is missing or false, set it and redeploy**

```bash
vercel env add BOULEVARD_ENABLE_UPGRADE_MUTATION production
# When prompted, enter: true
vercel --prod --yes
```

Wait ~30 seconds for deploy. Then re-run Step 0.1 to confirm.

- [ ] **Step 0.4: Delete the local env pull (it contains secrets)**

```bash
rm .env.production.local
```

- [ ] **Step 0.5: Record observed state in the plan execution log**

In a scratch note (not committed): record the actual values you saw. This is the baseline for rollback if anything later goes wrong.

---

## Step 1: Diagnostic Data Collection

**Goal:** For each of the test cases (Donatella, Amanda, Travis's 5-of-6 NOs), produce a labeled failure mode. Without this data every fix below is a guess.

### Step 1a: Pull existing Vercel runtime logs (no code change)

- [ ] **Step 1a.1: Pull recent function logs for the two upgrade routes**

```bash
vercel logs --since 14d --output raw 'sm-member-cancel' | grep -E 'tryApplyAppointmentUpgradeMutation|upgrade_mutation_failed|tryApplyAddonViaBookingFromAppointment|addon_booking_from_appointment_failed' > /tmp/vercel-upgrade-logs.txt
wc -l /tmp/vercel-upgrade-logs.txt
head -50 /tmp/vercel-upgrade-logs.txt
```

If the file has zero or trivial content, runtime logs do not retain enough context — skip to Step 1b (PR-DIAG).

If the file has substantive content, search it for Donatella and Amanda by appointment ID. If those records are present with discriminating `reason=` values, you can skip Step 1b and go directly to Step 1c (Twilio pull) and then Step 1d (synthesize).

- [ ] **Step 1a.2: Check Sentry for Boulevard GraphQL errors in the same window**

Per CLAUDE.md, Sentry is wired in code but **inert until a DSN is set**. First check:

```bash
vercel env ls production | grep -E 'SENTRY_DSN|NEXT_PUBLIC_SENTRY_DSN'
```

If both are unset, Sentry is not capturing anything. Skip this step and proceed directly to Step 1b (PR-DIAG). Do NOT enable Sentry as part of this plan — that's a separate decision with its own setup (org creation, DSN, source-map auth token, redeploy). Note "Sentry not configured" in your scratch tracking.

If a DSN IS set, open the Sentry project. Filter to events tagged `boulevard` or containing `runMutationRoot` in the stack, last 14 days. Export any matching events. If Sentry has zero relevant events even with DSN configured, treat as confirming Step 1b is needed.

### Step 1b: Ship PR-DIAG — temporary verbose Boulevard logging (only if Step 1a was insufficient)

**Files:**
- Create: `__tests__/boulevard-verbose-diagnostic-log.test.js`
- Modify: `src/lib/boulevard.js:2633-2645` (the `runMutationRoot` function)
- Modify: `.env.example` (add the new flag)

- [ ] **Step 1b.1: Create a feature branch**

```bash
cd ~/sm-member-cancel
git checkout -b fix/sms-pr-diag-verbose-boulevard-logging
```

- [ ] **Step 1b.2: Write the failing test for redaction**

This repo's existing test pattern (see `__tests__/boulevard-cancel-rebook-notes.test.js`) mocks `global.fetch` and tests through exported functions. The internal `runMutationRoot` and `fetchBoulevardGraphQL` are NOT exported, so we test the verbose-log behavior indirectly by invoking a code path that calls them and asserting on `console.log` output.

For the diagnostic-log test, we add a tiny named export (`__runMutationRootForTests`) to the existing test-exports list at `src/lib/boulevard.js:4361`. This follows the repo's convention — `__resetBoulevardCachesForTests` is already exported with the same `__*ForTests` naming pattern.

Create `__tests__/boulevard-verbose-diagnostic-log.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;
const originalFetch = global.fetch;

describe('verbose diagnostic logging in runMutationRoot', () => {
  let consoleSpy;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
    };
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('does not log mutation bodies when flag is unset', async () => {
    delete process.env.BOULEVARD_VERBOSE_DIAGNOSTIC_LOG;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { someMutation: { id: 'x' } } }),
    }));
    const { __runMutationRootForTests } = await import('../src/lib/boulevard.js');
    await __runMutationRootForTests(
      'https://example.invalid',
      {},
      'mutation { someMutation { id } }',
      { phone: '+15555555555' },
      'someMutation',
    );
    const verboseCalls = consoleSpy.mock.calls.filter(args =>
      String(args[0] || '').includes('[BOULEVARD_VERBOSE]'),
    );
    expect(verboseCalls).toHaveLength(0);
  });

  it('logs root and ok status when flag is true', async () => {
    process.env.BOULEVARD_VERBOSE_DIAGNOSTIC_LOG = 'true';
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { someMutation: { id: 'x' } } }),
    }));
    const { __runMutationRootForTests } = await import('../src/lib/boulevard.js');
    await __runMutationRootForTests(
      'https://example.invalid',
      {},
      'mutation { someMutation { id } }',
      { appointmentId: 'appt-1' },
      'someMutation',
    );
    const verboseCalls = consoleSpy.mock.calls.filter(args =>
      String(args[0] || '').includes('[BOULEVARD_VERBOSE]'),
    );
    expect(verboseCalls.length).toBeGreaterThanOrEqual(1);
    const firstCall = JSON.stringify(verboseCalls[0]);
    expect(firstCall).toContain('someMutation');
    expect(firstCall).toContain('"ok":true');
  });

  it('redacts phone, email, and notes fields when logging variables', async () => {
    process.env.BOULEVARD_VERBOSE_DIAGNOSTIC_LOG = 'true';
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { someMutation: { id: 'x' } } }),
    }));
    const { __runMutationRootForTests } = await import('../src/lib/boulevard.js');
    await __runMutationRootForTests(
      'https://example.invalid',
      {},
      'mutation { someMutation { id } }',
      {
        appointmentId: 'appt-1',
        phone: '+15555555555',
        email: 'member@example.com',
        notes: 'Member requested extra warm towels',
      },
      'someMutation',
    );
    const verboseCalls = consoleSpy.mock.calls.filter(args =>
      String(args[0] || '').includes('[BOULEVARD_VERBOSE]'),
    );
    const joined = JSON.stringify(verboseCalls);
    expect(joined).not.toContain('+15555555555');
    expect(joined).not.toContain('member@example.com');
    expect(joined).not.toContain('extra warm towels');
    expect(joined).toMatch(/phone_sha8":"[0-9a-f]{8}"/);
    expect(joined).toMatch(/email_sha8":"[0-9a-f]{8}"/);
    expect(joined).toMatch(/notes_sha8":"[0-9a-f]{8}"/);
  });
});
```

- [ ] **Step 1b.3: Run the test to verify it fails**

```bash
npm test -- boulevard-verbose-diagnostic-log
```

Expected: FAIL — `__runMutationRootForTests` is not yet exported from `src/lib/boulevard.js`. Error like `__runMutationRootForTests is not a function`. That's the right failure to see before implementing Step 1b.4.

- [ ] **Step 1b.4: Implement verbose logging with redaction**

First check existing `node:crypto` usage to avoid double-import:

```bash
grep -n "node:crypto\|from 'crypto'\|require('crypto')" src/lib/boulevard.js
```

If `createHash` is already imported, reuse it. Otherwise add `import { createHash } from 'node:crypto';` near the top of the file (after the other imports).

Add these helpers above `runMutationRoot` (currently at line ~2633):

```javascript
const VERBOSE_REDACT_KEYS = new Set(['phone', 'email', 'notes', 'note', 'internalNotes', 'internalNote']);

function sha8ForVerboseLog(value) {
  if (value === null || value === undefined) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function redactVariablesForVerboseLog(variables) {
  if (!variables || typeof variables !== 'object') return variables;
  if (Array.isArray(variables)) return variables.map(redactVariablesForVerboseLog);
  const out = {};
  for (const [key, value] of Object.entries(variables)) {
    if (VERBOSE_REDACT_KEYS.has(key)) {
      out[`${key}_sha8`] = sha8ForVerboseLog(value);
    } else if (value && typeof value === 'object') {
      out[key] = redactVariablesForVerboseLog(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
```

Replace `runMutationRoot` (currently at line ~2633) with:

```javascript
async function runMutationRoot(apiUrl, headers, query, variables, root) {
  const data = await fetchBoulevardGraphQL(
    apiUrl,
    headers,
    query,
    variables,
    { silentErrors: true, returnErrors: true },
  );
  if (process.env.BOULEVARD_VERBOSE_DIAGNOSTIC_LOG === 'true') {
    const ok = Boolean(data && !data.__error && data?.data?.[root]);
    console.log('[BOULEVARD_VERBOSE]', JSON.stringify({
      root,
      ok,
      variables: redactVariablesForVerboseLog(variables),
      error: data?.__error || null,
      hasPayload: Boolean(data?.data?.[root]),
    }));
  }
  if (data?.__error) return { ok: false, error: data.__error, payload: null };
  const payload = data?.data?.[root] || null;
  if (!payload) return { ok: false, error: { stage: 'empty_payload' }, payload: null };
  return { ok: true, payload, error: null };
}
```

Add `runMutationRoot` to the test exports (at line 4361). The pattern is to alias it for clarity that it's a test-only escape hatch:

```javascript
export {
  // ...existing exports...
  __resetBoulevardCachesForTests,
  runMutationRoot as __runMutationRootForTests,
};
```

- [ ] **Step 1b.5: Add flag to `.env.example`**

Edit `.env.example`. Add under the Boulevard section:

```
# Temporary diagnostic flag — when true, logs Boulevard mutation root, ok status,
# and redacted variables to console for diagnostic windows. Off in normal operation.
# Phone, email, and notes fields are SHA-256 hashed and truncated to 8 chars.
BOULEVARD_VERBOSE_DIAGNOSTIC_LOG=false
```

- [ ] **Step 1b.6: Run the test to verify it passes**

```bash
npm test -- boulevard-verbose-diagnostic-log
```

Expected: PASS — all three assertions green.

- [ ] **Step 1b.7: Run the full test suite to confirm no regressions**

```bash
npm test
```

Expected: 244+ tests pass.

- [ ] **Step 1b.8: Commit and push**

```bash
git add __tests__/boulevard-verbose-diagnostic-log.test.js src/lib/boulevard.js .env.example
git commit -m "fix(boulevard): add temporary verbose diagnostic logging with PII redaction

Gated by BOULEVARD_VERBOSE_DIAGNOSTIC_LOG=true. Logs mutation root, ok status,
and redacted variables (phone/email/notes hashed via SHA-256 truncated to 8 chars).
For the SMS reactivation diagnostic window only; revert after data collected.

Refs: docs/PLAN_sms-reactivation-2026-05-25.md Step 1b"
git push -u origin fix/sms-pr-diag-verbose-boulevard-logging
```

- [ ] **Step 1b.9: Open PR and merge after CI passes**

```bash
gh pr create --base main --title "fix(boulevard): temporary verbose diagnostic logging (PR-DIAG)" --body "$(cat <<'EOF'
## Summary
- Adds gated verbose logging to runMutationRoot so the SMS reactivation diagnostic window has structured failure data.
- Phone/email/notes redacted via SHA-256 truncated to 8 chars before logging.
- Off by default; enabled in production via BOULEVARD_VERBOSE_DIAGNOSTIC_LOG=true for the diagnostic window only.

## Test plan
- [x] New test file boulevard-verbose-diagnostic-log.test.js covers off/on/redaction
- [x] Full vitest suite passes
- [ ] After merge, set BOULEVARD_VERBOSE_DIAGNOSTIC_LOG=true in prod via `vercel env add` + `vercel --prod --yes`
- [ ] Wait 24-48h for real member opt-ins
- [ ] Pull logs via `vercel logs` grep `[BOULEVARD_VERBOSE]`
- [ ] After data collected, revert this PR (or unset the env var) before Step 5

Refs: docs/PLAN_sms-reactivation-2026-05-25.md Step 1b
EOF
)"
```

After CI passes and PR is merged, Vercel auto-deploys main in ~30s.

- [ ] **Step 1b.10: Enable the flag in production**

```bash
vercel env add BOULEVARD_VERBOSE_DIAGNOSTIC_LOG production
# When prompted, enter: true
vercel --prod --yes
```

Wait ~30s for deploy.

- [ ] **Step 1b.11: Wait for diagnostic data**

Wait 24-48 hours for real member SMS opt-ins to flow through the cron and webhook. Then proceed.

- [ ] **Step 1b.12: Pull the verbose logs**

```bash
vercel logs --since 48h --output raw 'sm-member-cancel' | grep '\[BOULEVARD_VERBOSE\]' > /tmp/boulevard-verbose.jsonl
wc -l /tmp/boulevard-verbose.jsonl
```

You should see one line per Boulevard mutation call attempted in the last 48h.

### Step 1c: Pull Twilio reply data for Travis's 5-of-6 NOs

- [ ] **Step 1c.1: Get the recipient phone numbers Travis flagged**

This step requires Travis to provide the appointment IDs OR recipient phone numbers OR a date window. If only a date window is known, pull all webhook log entries in that window:

```bash
vercel logs --since 7d --output raw 'sm-member-cancel' | grep -E 'sms/twilio/webhook' > /tmp/webhook-logs.txt
```

- [ ] **Step 1c.2: For each flagged recipient, cross-reference Twilio Console**

Open Twilio Console → Messages → Logs. Filter to outbound from `+18885127546` and inbound from each flagged member's number in the relevant window. Export the inbound message bodies.

- [ ] **Step 1c.3: For each inbound YES, check whether it matched the regex**

The regex is at `src/app/api/sms/twilio/webhook/route.js:36`:

```
/\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|let's do it|sounds good|please|absolutely)\b/i
```

Test each captured inbound message body locally:

```bash
node -e '
const YES = /\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|let'"'"'s do it|sounds good|please|absolutely)\b/i;
const tests = ["YES", "yes please", "Sure!", "Let'"'"'s extend!", "I'"'"'d like to extend"];
for (const t of tests) console.log(JSON.stringify(t), YES.test(t.toLowerCase()));
'
```

Replace the `tests` array with the actual member replies. Record which ones matched and which did not.

### Step 1d: Synthesize the diagnostic outcome

- [ ] **Step 1d.1: Build the failure-mode table**

In a scratch file (do not commit), build a table:

| Case | Source | Reply text | Regex matched? | Mutation attempted? | Boulevard root | Boulevard error/reason | Failure class |
|------|--------|------------|---------------|--------------------|-----------------|------------------------|---------------|
| Donatella | runtime logs | n/a | n/a | yes | `updateAppointment` | (from log) | (assign) |
| Amanda | runtime logs | n/a | n/a | yes | `updateAppointment` | (from log) | (assign) |
| NO #1 | Twilio + webhook log | (text) | yes/no | yes/no | ... | ... | ... |
| ... | ... | ... | ... | ... | ... | ... | ... |

Failure class is one of:
- `regex_miss` (reply did not match YES regex)
- `offer_expired` (pending offer existed but expired before reply)
- `klaviyo_gate` (TCPA opt-out blocked send or reply processing)
- `update_appointment_error` (`updateAppointment` returned a Boulevard error — record the code)
- `update_appointment_misroute` (mutation succeeded but result was not surfaced to the success path)
- `addon_booking_from_appointment_warning` (record the warning code)
- `addon_base_booking_service_resolution` (`baseBookingServiceId` did not resolve)
- `addon_add_service_addon_failure` (`bookingAddServiceAddon` failed)
- `member_said_no` (offer was undesirable, no code change required)

- [ ] **Step 1d.2: Pick the Step 2 branch (duration fix)**

Based on the duration cases (Donatella, Amanda) and any duration-class entries in Travis's set:

- If failure class is `update_appointment_error` → Step 2 executes branch **2a**.
- If failure class is `update_appointment_misroute` → Step 2 executes branch **2b**.
- If failure class is `regex_miss` → Step 2 executes branch **2c**.
- If failure class is `member_said_no` for all cases → Step 2 executes branch **2d** (no code fix; the addon-only gate scaffolding still ships).
- If failure class is `offer_expired` → Step 2 executes branch **2e** (extend the YES window).
- If failure class is `klaviyo_gate` → Step 2 executes branch **2f** (gate diagnostic + remediation).

Mixed-class outcomes: ship the addon-only gate plus the dominant branch. Repeat Step 2 with the second branch in a follow-up PR.

- [ ] **Step 1d.3: Pick the Step 4 branch (addon fix)**

Based on the addon cases:

- If failure class is `addon_booking_from_appointment_warning` → Step 4 executes branch **4a** (record the warning code from the verbose log).
- If failure class is `addon_base_booking_service_resolution` → Step 4 executes branch **4b**.
- If failure class is `addon_add_service_addon_failure` → Step 4 executes branch **4c**.

- [ ] **Step 1d.4: Update this plan with the selected branches**

Edit this file (`docs/PLAN_sms-reactivation-2026-05-25.md`) and append a "Diagnostic Outcome" section at the bottom:

```markdown
## Diagnostic Outcome (recorded after Step 1d)

Recorded on: <date>
Step 2 branch selected: <2a|2b|2c|2d>
Step 4 branch selected: <4a|4b|4c|none>
Cases summary:
- Donatella: <failure class> (<Boulevard error/reason if applicable>)
- Amanda: <failure class>
- Travis NO #1: ...
- ...
```

Commit this update to the plan file on `main` (it's documentation, not a feature change).

---

## Step 2: PR β.5 (addon-only gate) + PR β (duration-upgrade fix)

**Goal:** Ship two small PRs in sequence per CLAUDE.md's one-fix-per-PR rule.

- **PR β.5** ships the `SMS_ADDON_OFFERS_ENABLED` gate FIRST (smallest possible diff, protective).
- **PR β** ships the duration-upgrade fix SECOND (branch-specific code from Step 1d).

Both must land before Step 3's flip. Ship them in this order so by the time duration is enabled, the addon gate is already in place and proven green by the test suite.

### Step 2A: PR β.5 — addon-only gate

**Files:**
- Create: `src/lib/sms-offer-gate.js`
- Create: `__tests__/sms-offer-gate.test.js`
- Modify: `src/app/api/sms/automation/pre-appointment/route.js` (import + filter)
- Modify: `.env.example` (new flag)

- [ ] **Step 2A.1: Create the PR branch**

```bash
cd ~/sm-member-cancel
git checkout main
git pull origin main
git checkout -b fix/sms-addon-offers-enabled-gate
```

### Step 2A (always): Addon-only gate

- [ ] **Step 2.2: Write the failing test for the addon-only gate**

The gate logic lives in a new pure-helper module so Next.js route files stay focused on request handling. Create `__tests__/sms-offer-gate.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;

describe('SMS_ADDON_OFFERS_ENABLED gate', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('addon-kind offers are filtered out when flag is unset', async () => {
    delete process.env.SMS_ADDON_OFFERS_ENABLED;
    const { isOfferKindEnabled } = await import('../src/lib/sms-offer-gate.js');
    expect(isOfferKindEnabled('addon')).toBe(false);
  });

  it('addon-kind offers are filtered out when flag is explicitly false', async () => {
    process.env.SMS_ADDON_OFFERS_ENABLED = 'false';
    const { isOfferKindEnabled } = await import('../src/lib/sms-offer-gate.js');
    expect(isOfferKindEnabled('addon')).toBe(false);
  });

  it('addon-kind offers pass through when flag is true', async () => {
    process.env.SMS_ADDON_OFFERS_ENABLED = 'true';
    const { isOfferKindEnabled } = await import('../src/lib/sms-offer-gate.js');
    expect(isOfferKindEnabled('addon')).toBe(true);
  });

  it('duration-kind offers always pass through regardless of flag', async () => {
    process.env.SMS_ADDON_OFFERS_ENABLED = 'false';
    const { isOfferKindEnabled } = await import('../src/lib/sms-offer-gate.js');
    expect(isOfferKindEnabled('duration')).toBe(true);
  });
});
```

- [ ] **Step 2.3: Run the test to verify it fails**

```bash
npm test -- sms-offer-gate
```

Expected: FAIL — `src/lib/sms-offer-gate.js` doesn't exist.

- [ ] **Step 2.4: Implement the gate module**

Create `src/lib/sms-offer-gate.js`:

```javascript
export function isOfferKindEnabled(offerKind) {
  const kind = String(offerKind || '').toLowerCase();
  if (kind === 'addon') return process.env.SMS_ADDON_OFFERS_ENABLED === 'true';
  return true;
}
```

Read the env var inside the function (not at module load) so test reruns with different env values work without `vi.resetModules()`.

Then wire it into `src/app/api/sms/automation/pre-appointment/route.js`:

```bash
grep -n "offerKind\|offer.offerKind\|opportunity.offerKind" src/app/api/sms/automation/pre-appointment/route.js | head
```

Add the import near the top:

```javascript
import { isOfferKindEnabled } from '../../../../lib/sms-offer-gate.js';
```

(Adjust the relative path to match the actual depth.) Find the candidate-dispatch site (where each `offer` or `opportunity` is processed) and short-circuit addon offers:

```javascript
if (!isOfferKindEnabled(offer.offerKind || opportunity?.offerKind)) {
  // skip dispatch — addon path gated off
  continue;
}
```

If the existing control flow doesn't use a loop with `continue`, adapt — the intent is: addon offers must NOT be dispatched when `SMS_ADDON_OFFERS_ENABLED !== 'true'`. Add a second test in `sms-offer-gate.test.js` that imports the route module and confirms an addon candidate is skipped — or, simpler, leave the integration verification to Step 3.5 (cron-tick observation) since the gate's unit test plus the existing pre-appointment route tests already cover the joint behavior.

- [ ] **Step 2.5: Add flag to `.env.example`**

Edit `.env.example`. Add:

```
# Per-offer-kind rollout gate. When false (default), addon offers are skipped by
# the pre-appointment cron even when SMS_CRON_ENABLED=true. Used for staged
# reactivation: duration flips on first, addon flips on after its path is verified.
SMS_ADDON_OFFERS_ENABLED=false
```

- [ ] **Step 2A.6: Run the gate tests to verify they pass**

```bash
npm test -- sms-offer-gate
```

Expected: PASS.

- [ ] **Step 2A.7: Full suite, commit, PR, merge**

```bash
npm test
git add src/lib/sms-offer-gate.js __tests__/sms-offer-gate.test.js src/app/api/sms/automation/pre-appointment/route.js .env.example
git commit -m "feat(sms): add SMS_ADDON_OFFERS_ENABLED gate

Per-offer-kind rollout flag. Default false. Lets the duration path re-enable
independently of the addon path during staged reactivation.

Refs: docs/PLAN_sms-reactivation-2026-05-25.md Step 2A"
git push -u origin fix/sms-addon-offers-enabled-gate
gh pr create --base main --title "feat(sms): add SMS_ADDON_OFFERS_ENABLED rollout gate" --body "Adds per-offer-kind gate so duration and addon paths can be flipped on independently. Default: off. Refs docs/PLAN_sms-reactivation-2026-05-25.md Step 2A."
```

Per CLAUDE.md, PR descriptions should name the QA_ISSUES.md issue number this PR addresses; add an entry to QA_ISSUES.md outbound-sms section for "addon-offer rollout gate" if one doesn't exist, and reference it in the PR body. Merge after CI passes; Vercel auto-deploys ~30s.

### Step 2B: PR β — duration-upgrade fix (branch-specific)

**Files (branch-specific, in addition to common test setup):**
- 2a: `src/lib/boulevard.js` (around `tryApplyAppointmentUpgradeMutation` at line 2332), `__tests__/boulevard-upgrade-mutation-error-handling.test.js`
- 2b: `src/lib/boulevard.js` (result routing in the upgrade caller), `__tests__/boulevard-upgrade-mutation-result-routing.test.js`
- 2c: `src/app/api/chat/message/route.js:51`, `src/app/api/sms/twilio/webhook/route.js:36`, `__tests__/yes-keyword-regex.test.js`
- 2d: QA_ISSUES.md only (no code change)
- 2e: `src/app/api/sms/automation/pre-appointment/route.js:44-45`, `__tests__/offer-window-extension.test.js`
- 2f: QA_ISSUES.md only (no code change in this PR; deeper Klaviyo work follows separately)

- [ ] **Step 2B.1: Create the PR branch off main (after PR β.5 is merged)**

```bash
cd ~/sm-member-cancel
git checkout main
git pull origin main
git checkout -b fix/sms-duration-upgrade-<branch-letter>
```

Where `<branch-letter>` matches the executed branch (e.g., `fix/sms-duration-upgrade-2a`).

### Step 2B (branch-specific): Execute ONLY the branch selected in Step 1d.2

**TESTING NOTE for all branches below.** This repo's test pattern (see `__tests__/boulevard-cancel-rebook-notes.test.js`) is:
- Set Boulevard env vars in `beforeEach` via `process.env = { ...originalEnv, ... }`.
- Mock `global.fetch` with a `vi.fn(async (_url, init) => { const body = JSON.parse(init.body); ... })` that inspects the GraphQL `query` string and returns shaped responses.
- Test through exported functions: `reverifyAndApplyUpgradeForProfile`, `evaluateUpgradeOpportunityForProfile`. Internal helpers like `tryApplyAppointmentUpgradeMutation` are not exported and should not be imported directly.

If a branch below requires asserting on internal-function behavior the exported API does not expose, add a test-only named export at the export block (`src/lib/boulevard.js:4361`) using the `__nameForTests` convention already used by `__resetBoulevardCachesForTests`. Do not add general-purpose exports.

#### Branch 2a: `updateAppointment` returns a Boulevard error

- [ ] **Step 2a.1: Write the failing test for surfacing the Boulevard error reason**

Create `__tests__/boulevard-upgrade-mutation-error-handling.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;
const originalFetch = global.fetch;

// Replace EXPECTED_BOULEVARD_ERROR_CODE with the actual error code observed
// in the Step 1 diagnostic verbose logs (e.g., 'INVALID_SERVICE', 'STAFF_DOES_NOT_PERFORM_SERVICE').
const BOULEVARD_ERROR_CODE = 'EXPECTED_BOULEVARD_ERROR_CODE';

describe('tryApplyAppointmentUpgradeMutation error surfacing (branch 2a)', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('surfaces the Boulevard error code in upgradeResult.reason', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      // Boulevard introspection calls: respond with minimal shapes so the function reaches the upgrade attempt
      if (query.includes('IntrospectType') || query.includes('IntrospectSchemaMutationType')) {
        return { ok: true, json: async () => ({ data: { __type: { fields: [] } } }) };
      }
      // The upgrade mutation: return the observed Boulevard error
      if (query.includes('updateAppointment') || query.includes('appointmentUpdate')) {
        return {
          ok: true,
          json: async () => ({
            errors: [{ message: 'rejected', extensions: { code: BOULEVARD_ERROR_CODE } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: null }) };
    });

    const { __tryApplyAppointmentUpgradeMutationForTests } = await import('../src/lib/boulevard.js');
    const result = await __tryApplyAppointmentUpgradeMutationForTests(
      'https://example.invalid', {}, 'appt-1', 'svc-1',
    );
    expect(result.applied).toBe(false);
    expect(String(result.reason)).toContain(BOULEVARD_ERROR_CODE.toLowerCase());
  });
});
```

The test requires adding `tryApplyAppointmentUpgradeMutation as __tryApplyAppointmentUpgradeMutationForTests` to the export block (same pattern as Step 1b.4).

Replace `EXPECTED_BOULEVARD_ERROR_CODE` with the actual code observed in Step 1d's table.

- [ ] **Step 2a.2: Run the test to verify it fails**

```bash
npm test -- boulevard-upgrade-mutation-error-handling
```

Expected: FAIL — the function currently returns generic `upgrade_mutation_failed` regardless of error code.

- [ ] **Step 2a.3: Modify `tryApplyAppointmentUpgradeMutation` to surface the error code**

Edit `src/lib/boulevard.js`. Find `tryApplyAppointmentUpgradeMutation` (currently at line 2332). The function uses `fetchBoulevardGraphQL` with `silentErrors: true` which discards error context. Change the call to `silentErrors: false, returnErrors: true` and capture the error:

```javascript
async function tryApplyAppointmentUpgradeMutation(apiUrl, headers, appointmentId, serviceId) {
  const mutationCandidates = [
    {
      root: 'updateAppointment',
      query: `
        mutation UpgradeAppointment($appointmentId: ID!, $serviceId: ID!) {
          updateAppointment(input: { id: $appointmentId, serviceId: $serviceId }) {
            appointment { id }
          }
        }
      `,
    },
    {
      root: 'appointmentUpdate',
      query: `
        mutation UpgradeAppointmentAlt($appointmentId: ID!, $serviceId: ID!) {
          appointmentUpdate(input: { id: $appointmentId, serviceId: $serviceId }) {
            appointment { id }
          }
        }
      `,
    },
  ];

  let lastErrorCode = null;
  for (const candidate of mutationCandidates) {
    const data = await fetchBoulevardGraphQL(
      apiUrl,
      headers,
      candidate.query,
      { appointmentId, serviceId },
      { silentErrors: true, returnErrors: true },
    );
    if (!data) continue;
    // fetchBoulevardGraphQL with returnErrors:true returns { __error: { stage, errors: [...] }, data } on GraphQL errors.
    // The Boulevard error code lives at __error.errors[0].extensions.code.
    const boulevardErrorCode =
      data?.__error?.errors?.[0]?.extensions?.code
      || data?.__error?.status
      || data?.__error?.stage
      || null;
    if (boulevardErrorCode) {
      lastErrorCode = String(boulevardErrorCode).toLowerCase();
    }
    const node = data?.data?.[candidate.root];
    const updatedId = node?.appointment?.id || node?.id || null;
    if (updatedId) return { applied: true, mutationRoot: candidate.root, updatedId: String(updatedId) };
  }

  return {
    applied: false,
    reason: lastErrorCode ? `upgrade_mutation_failed:${lastErrorCode}` : 'upgrade_mutation_failed',
  };
}
```

If the test's `EXPECTED_BOULEVARD_ERROR_CODE` is e.g. `INVALID_SERVICE`, the reason becomes `upgrade_mutation_failed:invalid_service`. The webhook's downstream incident routing already includes `reason` in its summary so the new code automatically surfaces in ops alerts.

- [ ] **Step 2a.4: Run the test to verify it passes**

```bash
npm test -- boulevard-upgrade-mutation-error-handling
```

Expected: PASS.

#### Branch 2b: `updateAppointment` succeeds but result is misrouted

- [ ] **Step 2b.1: Write the failing test for the misroute**

Use the exported `reverifyAndApplyUpgradeForProfile` and mock `global.fetch`. The actual misroute location will be visible in the Step 1 logs.

Create `__tests__/boulevard-upgrade-mutation-result-routing.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;
const originalFetch = global.fetch;

describe('upgrade mutation result routing (branch 2b)', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('propagates success:true when updateAppointment returns an appointment id', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      if (query.includes('IntrospectType') || query.includes('IntrospectSchemaMutationType')) {
        return { ok: true, json: async () => ({ data: { __type: { fields: [] } } }) };
      }
      if (query.includes('appointment(id') || query.includes('FetchAppointmentContext')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointment: {
                id: 'appt-1',
                clientId: 'client-1',
                locationId: 'loc-1',
                startAt: '2026-05-25T15:00:00Z',
                appointmentServices: [{ id: 'as-1', serviceId: 'svc-30', staffId: 'staff-1' }],
              },
            },
          }),
        };
      }
      if (query.includes('updateAppointment') || query.includes('appointmentUpdate')) {
        return {
          ok: true,
          json: async () => ({ data: { updateAppointment: { appointment: { id: 'appt-1' } } } }),
        };
      }
      return { ok: true, json: async () => ({ data: null }) };
    });

    const { reverifyAndApplyUpgradeForProfile } = await import('../src/lib/boulevard.js');
    // Construct opportunity matching the misroute scenario from Step 1 logs.
    // The exact shape comes from the diagnostic — replace the placeholders below.
    const profile = { clientId: 'client-1', tier: '30', accountStatus: 'active' };
    const opportunity = {
      appointmentId: 'appt-1',
      currentServiceId: 'svc-30',
      targetServiceId: 'svc-50',
      offerKind: 'duration',
      providerId: 'staff-1',
      locationId: 'loc-1',
    };
    const result = await reverifyAndApplyUpgradeForProfile({ profile, opportunity });
    expect(result.success).toBe(true);
    expect(String(result.reason)).toMatch(/applied|upgraded/);
  });
});
```

- [ ] **Step 2b.2: Run, observe failure, fix the misroute** in `reverifyAndApplyUpgradeForProfile` near `src/lib/boulevard.js:3689` (where `ENABLE_UPGRADE_MUTATION` is checked) or at the actual misroute site identified in the diagnostic. Re-run until passing.

#### Branch 2c: YES regex misses real member phrases

- [ ] **Step 2c.1: Write the failing test for the new phrases**

Create `__tests__/yes-keyword-regex.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

// Replace MISSED_PHRASES with the actual phrases captured in Step 1d's table
// that did NOT match the existing regex but were genuine YES responses.
const MISSED_PHRASES = [
  "I'd like to extend",
  "let's extend",
  // ...add more as captured
];

const YES_REGEX = /\b(yes|yeah|yep|sure|ok|okay|do it|add it|upgrade|extend|let's do it|let's extend|sounds good|please|absolutely|i'd like to)\b/i;

describe('YES keyword regex', () => {
  for (const phrase of MISSED_PHRASES) {
    it(`matches "${phrase}"`, () => {
      expect(YES_REGEX.test(phrase.toLowerCase())).toBe(true);
    });
  }

  it('does not match obvious NO responses', () => {
    expect(YES_REGEX.test('no thanks')).toBe(false);
    expect(YES_REGEX.test('not today')).toBe(false);
    expect(YES_REGEX.test('skip')).toBe(false);
  });
});
```

- [ ] **Step 2c.2: Run, verify failures, expand the regex in BOTH files**

Edit `src/app/api/chat/message/route.js:51` and `src/app/api/sms/twilio/webhook/route.js:36` to use the new pattern. The two regexes must stay identical — they're the same logical contract. Add a comment above each pointing to the other.

- [ ] **Step 2c.3: Run the test until passing, then run the full suite**

#### Branch 2d: Members said NO; no code fix

- [ ] **Step 2d.1: Document the outcome in QA_ISSUES.md**

Edit `QA_ISSUES.md`. Add an entry under outbound-sms describing the diagnostic outcome: members declined desirable offers; no code change. This becomes the record for why we proceeded with the flip.

#### Branch 2e: Offer expired before the YES reply landed

The current offer window is 15 minutes (`OFFER_WINDOW_MINUTES`) and the reminder window is 10 minutes (`REMINDER_YES_WINDOW_MINUTES`), both at `src/app/api/sms/automation/pre-appointment/route.js:44-45`. Humans reply slower than that — Travis's diagnostic may show members reply 20-45 minutes after the offer.

- [ ] **Step 2e.1: Write the failing test for the extended window**

Create `__tests__/offer-window-extension.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;

describe('YES_RESPONSE_WINDOW_MIN defaults', () => {
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('defaults to 60 minutes when YES_RESPONSE_WINDOW_MIN is unset', async () => {
    delete process.env.YES_RESPONSE_WINDOW_MIN;
    const mod = await import('../src/app/api/sms/automation/pre-appointment/route.js');
    // If the constant is read inside a helper, expose it via a tiny exported function or assert through behavior.
    // Minimal assertion: the documented default is 60 in this branch.
    expect(Number(process.env.YES_RESPONSE_WINDOW_MIN || 60)).toBe(60);
  });

  it('defaults to 30 minutes when YES_RESPONSE_WINDOW_REMINDER_MIN is unset', async () => {
    delete process.env.YES_RESPONSE_WINDOW_REMINDER_MIN;
    expect(Number(process.env.YES_RESPONSE_WINDOW_REMINDER_MIN || 30)).toBe(30);
  });
});
```

- [ ] **Step 2e.2: Update the defaults in `src/app/api/sms/automation/pre-appointment/route.js:44-45`**

```javascript
const OFFER_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_MIN || 60);
const REMINDER_YES_WINDOW_MINUTES = Number(process.env.YES_RESPONSE_WINDOW_REMINDER_MIN || 30);
```

Document the change in QA_ISSUES.md (windows previously 15/10 min, observed median reply latency from Step 1 was N min, extended to 60/30 with env overrides preserved).

#### Branch 2f: Klaviyo TCPA gate blocked send or reply processing

DO NOT TOUCH the Klaviyo client integration in this PR. Per CLAUDE.md, the TCPA consent check is the legal gate (controlled by env var `SMS_REQUIRE_KLAVIYO_OPT_IN` and the per-profile check in `src/lib/klaviyo.js`). This branch is diagnostic-only: confirm whether the gate fired, then either escalate to Travis for member-by-member resolution via the Klaviyo dashboard, or queue a separate Klaviyo-only PR (post-Step 3) if the gate logic itself misroutes.

- [ ] **Step 2f.1: Cross-reference Klaviyo subscription state**

For each affected member from Step 1 (where logs show `klaviyo_gate` failure), open the Klaviyo dashboard and check the member's SMS subscription state. If they show "subscribed" in Klaviyo but the gate is rejecting them, the calling code is misrouting — log this as a follow-up PR after Step 3. If they show "not subscribed" or "unsubscribed," the gate is working correctly and no code change is needed; Travis follows up operationally.

- [ ] **Step 2f.2: Document outcome in QA_ISSUES.md**

Add a Klaviyo-gate entry to QA_ISSUES.md under outbound-sms with the cross-reference results. No PR β code change.

### Step 2B (always): Finalize

- [ ] **Step 2B.last.1: Run the full test suite**

```bash
npm test
```

Expected: 244+ tests pass (now 245-246 with new branch-specific tests added).

- [ ] **Step 2B.last.2: Commit and push**

```bash
git add -A
git commit -m "fix(sms): duration upgrade <branch-specific summary>

<one-line description of the specific branch executed: e.g., 'surface Boulevard error code in upgrade_mutation_failed reason' for 2a>

Refs: docs/PLAN_sms-reactivation-2026-05-25.md Step 2B (branch <letter>)"
git push -u origin fix/sms-duration-upgrade-<branch-letter>
```

- [ ] **Step 2B.last.3: Open PR and merge**

```bash
gh pr create --base main --title "fix(sms): duration upgrade <branch-specific summary>" --body "..."
```

PR body should follow CLAUDE.md convention: name the relevant QA_ISSUES.md issue number, describe the diagnostic-driven choice of branch, list the test added.

---

## Step 3: Flip Duration ON

**Goal:** Enable duration upgrades end-to-end with addon path still gated off.

**Files:** None (env var changes only).

**Ordering matters.** Set the addon-off gate FIRST so it is durably true in the project env before either the manual-approval flag or the cron flag goes live. Vercel propagation across cron worker instances is usually atomic, but cron ticks run every 10 minutes and the cost of mis-ordering (addon dispatch into a broken path) is real. Do not parallelize these.

- [ ] **Step 3.1: Set `SMS_ADDON_OFFERS_ENABLED=false` (FIRST)**

```bash
vercel env add SMS_ADDON_OFFERS_ENABLED production
# When prompted, enter: false
```

(If the env var already exists from PR β.5 taking effect, use `vercel env rm` first or `vercel env pull` to confirm state.) Do NOT redeploy yet — both Step 3.1 and 3.2 below take effect on the same single redeploy in Step 3.4. The addon gate value just needs to be the latest committed value in project settings before the cron flips on.

- [ ] **Step 3.2: Set `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=false`**

```bash
vercel env rm SMS_REQUIRE_MANUAL_LIVE_APPROVAL production --yes
vercel env add SMS_REQUIRE_MANUAL_LIVE_APPROVAL production
# When prompted, enter: false
```

- [ ] **Step 3.3: Set `SMS_CRON_ENABLED=true` (LAST)**

```bash
vercel env rm SMS_CRON_ENABLED production --yes
vercel env add SMS_CRON_ENABLED production
# When prompted, enter: true
```

This is the master enable. The previous two values must already be set (Steps 3.1, 3.2) before this flip.

- [ ] **Step 3.4: Redeploy**

```bash
vercel --prod --yes
```

Wait ~30s. The next cron tick (up to 10 minutes after redeploy stabilizes) is the first live run.

- [ ] **Step 3.5: Verify the cron starts producing sends**

Per CLAUDE.md, the cron only sends inside the 9 AM-7 PM America/New_York window. If you flip the gate at 8 PM ET, expect zero sends until 9 AM the next day. Do Step 3.4 during the send window (or accept the overnight delay).

Watch logs for 10-20 minutes (one or two cron ticks during the window):

```bash
vercel logs --since 30m --output raw 'sm-member-cancel' | grep -E 'sms-upgrade-scan|sent:|upgrade.*applied'
```

CLAUDE.md verification rubric: if `summary.sent === 0` across many in-window runs AND `results[]` does NOT show legitimate skip reasons (Klaviyo not subscribed, no upcoming appointment, cooldown), something is wrong. Before concluding "failed," confirm:
1. `SMS_CRON_ENABLED=true` actually took effect (`vercel env ls production`).
2. You're inside the 9 AM-7 PM ET send window.
3. `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=false` is set (otherwise it silently holds sends).

If all three are confirmed and sent is still zero, escalate — do NOT just keep waiting.

- [ ] **Step 3.6: Verify a successful duration upgrade landed**

Wait up to 48 hours for a real member to opt in. Then:

```bash
vercel logs --since 48h --output raw 'sm-member-cancel' | grep -E 'applied.*duration|updateAppointment.*success|"You'\''re all set'
```

Expected: at least one entry showing successful `updateAppointment` and the `"You're all set. See you soon."` reply at `webhook/route.js:136`.

If after 48h no successful upgrades are observed, see Rollback below.

- [ ] **Step 3.7: Update QA_ISSUES.md**

Add an entry under outbound-sms marking the duration path as VERIFIED FIXED with the date and a one-line evidence summary. Commit directly to main:

```bash
cd ~/sm-member-cancel
git pull origin main
# Edit QA_ISSUES.md
git add QA_ISSUES.md
git commit -m "docs(QA_ISSUES): outbound-sms duration upgrade VERIFIED FIXED $(date +%Y-%m-%d)"
git push origin main
```

### Step 3 Rollback (only if Step 3.6 fails)

```bash
vercel env rm SMS_CRON_ENABLED production --yes
vercel env add SMS_CRON_ENABLED production
# When prompted, enter: false
vercel --prod --yes
```

Then investigate. Returning to Step 1 for fresh diagnostic data is often correct.

---

## Step 4: PR γ — Addon Non-Destructive Path Fix

**Goal:** Fix whatever the Step 1 diagnostic showed for addon failures so `tryApplyAddonViaBookingFromAppointment` succeeds for real members.

**Files (always):**
- Modify: `src/lib/boulevard.js` (branch-specific location below)
- Create: `__tests__/boulevard-addon-from-appointment-fix.test.js`

- [ ] **Step 4.1: Create the PR branch**

```bash
cd ~/sm-member-cancel
git checkout main
git pull origin main
git checkout -b fix/sms-addon-non-destructive-path
```

### Step 4 branches: execute ONLY the branch selected in Step 1d.3

Same TESTING NOTE as Step 2: mock `global.fetch` and test through the exported `reverifyAndApplyUpgradeForProfile`, OR add a `__tryApplyAddonViaBookingFromAppointmentForTests` named export following the `__*ForTests` convention.

#### Branch 4a: Boulevard warning class on `bookingCreateFromAppointment`

The warning code will be in the Step 1d table. Replace `EXPECTED_WARNING_CODE` below with the observed value.

- [ ] **Step 4a.1: Write the failing test**

Create `__tests__/boulevard-addon-from-appointment-fix.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;
const originalFetch = global.fetch;

// EXPECTED_WARNING_CODE captured in Step 1d table.
const WARNING_CODE = 'EXPECTED_WARNING_CODE';

describe('tryApplyAddonViaBookingFromAppointment warning handling (branch 4a)', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not treat the observed-warning-class as blocking', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      if (query.includes('IntrospectType') || query.includes('IntrospectSchemaMutationType')) {
        return { ok: true, json: async () => ({ data: { __type: { fields: [] } } }) };
      }
      if (query.includes('bookingCreateFromAppointment')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              bookingCreateFromAppointment: {
                booking: {
                  id: 'booking-1',
                  bookingClients: [{ id: 'bc-1', clientId: 'client-1' }],
                  bookingServices: [{
                    id: 'bs-1',
                    baseBookingServiceId: '',
                    editingAppointmentServiceId: 'appt-svc-1',
                    serviceId: 'svc-base',
                    staffId: 'staff-1',
                  }],
                },
                bookingWarnings: [{ code: WARNING_CODE, message: 'observed warning' }],
              },
            },
          }),
        };
      }
      if (query.includes('bookingAddServiceAddon')) {
        return { ok: true, json: async () => ({ data: { bookingAddServiceAddon: { booking: { id: 'booking-1' } } } }) };
      }
      if (query.includes('bookingComplete')) {
        return { ok: true, json: async () => ({ data: { bookingComplete: { booking: { id: 'booking-1' }, bookingAppointments: [{ id: 'appt-2' }] } } }) };
      }
      return { ok: true, json: async () => ({ data: null }) };
    });

    const { __tryApplyAddonViaBookingFromAppointmentForTests } = await import('../src/lib/boulevard.js');
    const result = await __tryApplyAddonViaBookingFromAppointmentForTests(
      'https://example.invalid', {},
      { appointmentId: 'appt-1', providerId: 'staff-1', appointmentServices: [{ id: 'appt-svc-1', staffId: 'staff-1' }] },
      'addon-svc-1',
    );
    expect(result.applied).toBe(true);
  });
});
```

Add the test export `tryApplyAddonViaBookingFromAppointment as __tryApplyAddonViaBookingFromAppointmentForTests` at the export block.

- [ ] **Step 4a.2: Run, observe failure**

```bash
npm test -- boulevard-addon-from-appointment-fix
```

- [ ] **Step 4a.3: Modify `hasBlockingBookingWarnings` to exempt the observed code**

Edit `src/lib/boulevard.js`. Find `hasBlockingBookingWarnings` (search for the function). It currently treats specific codes as blocking. If the observed warning is a non-blocking one (e.g., informational), remove it from the blocking set. If it's a new code class, add an explicit "informational warnings" set:

```javascript
const INFORMATIONAL_BOOKING_WARNING_CODES = new Set([
  'EXPECTED_WARNING_CODE',
  // add more as observed
]);

function hasBlockingBookingWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return false;
  const blockingCodes = new Set([
    'RESOURCE_DOUBLE_BOOKED',
    'STAFF_DOUBLE_BOOKED',
    'STAFF_DOES_NOT_PERFORM_SERVICE',
  ]);
  return warnings.some(warning => {
    const code = String(warning?.code || '').trim().toUpperCase();
    if (INFORMATIONAL_BOOKING_WARNING_CODES.has(code)) return false;
    return blockingCodes.has(code);
  });
}
```

- [ ] **Step 4a.4: Run test, full suite, commit**

#### Branch 4b: `baseBookingServiceId` resolution fails

The matcher logic is at `src/lib/boulevard.js:3127`. The bug is likely that `editingAppointmentServiceId` does not match the source appointment service id captured in the Step 1 logs.

- [ ] **Step 4b.1: Write the failing test using the same global.fetch pattern as 4a.**

Use the 4a test scaffold above; differences:
- In the `bookingCreateFromAppointment` response, set `editingAppointmentServiceId: 'DIFFERENT_ID'` (intentionally mismatched).
- Assert `result.applied === true` (current code falls through to the second `find` which picks the first base service, but if Step 1 shows that ALSO fails, the test will fail there).

- [ ] **Step 4b.2: Implement the fix at the matcher**

Edit `src/lib/boulevard.js` around line 3127. Current matcher:

```javascript
const baseBookingService = bookingServices.find(service =>
  !String(service?.baseBookingServiceId || '').trim() &&
  String(service?.editingAppointmentServiceId || '').trim() === sourceAppointmentServiceId,
) || bookingServices.find(service => !String(service?.baseBookingServiceId || '').trim()) || null;
```

The exact fix depends on the diagnostic. Two likely shapes:

Shape A (matcher should also accept staff correspondence):

```javascript
const baseBookingService = bookingServices.find(service =>
  !String(service?.baseBookingServiceId || '').trim() &&
  String(service?.editingAppointmentServiceId || '').trim() === sourceAppointmentServiceId,
) || bookingServices.find(service =>
  !String(service?.baseBookingServiceId || '').trim() &&
  String(service?.staffId || '').trim() === String(sourcePrimaryAppointmentService?.staffId || '').trim(),
) || bookingServices.find(service => !String(service?.baseBookingServiceId || '').trim()) || null;
```

Shape B (source id derivation is wrong): trace `sourceAppointmentServiceId` back to where it's set and align it with the field name Boulevard actually returns. Pick the shape that matches the observed failure.

- [ ] **Step 4b.3: Run test, full suite, commit**

#### Branch 4c: `bookingAddServiceAddon` itself fails

- [ ] **Step 4c.1: Write the failing test** with the actual error/warning class captured in Step 1d. Follow the pattern of 4a but at `boulevard.js:3163`.

- [ ] **Step 4c.2: Fix the handling** at the addon attempt site (`:3163` area). Likely scope: tighter warning handling or input mapping.

### Step 4 (always): Finalize

- [ ] **Step 4.X.last: Run full suite**

```bash
npm test
```

Expected: 244+ tests pass.

- [ ] **Step 4.Y.last: Commit and push**

```bash
git add -A
git commit -m "fix(sms): addon non-destructive path <branch-specific>

<one-line description of the specific fix>

Refs: docs/PLAN_sms-reactivation-2026-05-25.md Step 4"
git push -u origin fix/sms-addon-non-destructive-path
```

- [ ] **Step 4.Z.last: PR + merge** with `gh pr create`.

---

## Step 5: Flip Addon ON

**Goal:** Enable addon offers end-to-end. Duration path stays on.

**Files:** None.

- [ ] **Step 5.1: Set `SMS_ADDON_OFFERS_ENABLED=true`**

```bash
vercel env rm SMS_ADDON_OFFERS_ENABLED production --yes
vercel env add SMS_ADDON_OFFERS_ENABLED production
# When prompted, enter: true
```

- [ ] **Step 5.2: Redeploy**

```bash
vercel --prod --yes
```

- [ ] **Step 5.3: Disable verbose diagnostic logging (revert the PR-DIAG flag)**

The Step 1b flag served its purpose. Turn it off:

```bash
vercel env rm BOULEVARD_VERBOSE_DIAGNOSTIC_LOG production --yes
vercel env add BOULEVARD_VERBOSE_DIAGNOSTIC_LOG production
# When prompted, enter: false
vercel --prod --yes
```

Optionally also revert the PR-DIAG commit so the code path is removed (cleaner, recommended after Step 5 stabilizes). Open a follow-up PR titled `revert: temporary verbose diagnostic logging (PR-DIAG cleanup)`.

- [ ] **Step 5.4: Watch for successful addon application**

Wait 24-48h. Then:

```bash
vercel logs --since 48h --output raw 'sm-member-cancel' | grep -E 'applied_addon_booking_from_appointment|bookingAddServiceAddon.*ok'
```

Expected: at least one entry showing the full successful chain.

- [ ] **Step 5.5: Update QA_ISSUES.md** with the addon-path VERIFIED FIXED date.

### Step 5 Rollback

```bash
vercel env rm SMS_ADDON_OFFERS_ENABLED production --yes
vercel env add SMS_ADDON_OFFERS_ENABLED production
# When prompted, enter: false
vercel --prod --yes
```

Duration stays on. Investigate addon failure, return to Step 4 with new diagnostic data if needed.

---

## Step 6: Optional Copy Polish

**Skip entirely** unless post-Step 3 or post-Step 5 you observe member confusion about whether the upgrade went through (Travis informal report, member callbacks).

**Files:**
- Create: `src/lib/sms-reply-copy.js` (extract `buildUpgradeApplyReply` here as a pure function)
- Modify: `src/app/api/sms/twilio/webhook/route.js` (import from the new module instead of defining inline)
- Create: `__tests__/sms-reply-copy.test.js`

- [ ] **Step 6.1: Extract `buildUpgradeApplyReply` to a new pure-helper module**

Create `src/lib/sms-reply-copy.js`:

```javascript
export function buildUpgradeApplyReply(upgradeResult, opportunity, pendingOffer = null) {
  if (upgradeResult?.success) {
    const offer = pendingOffer || opportunity;
    const kind = String(offer?.offerKind || 'duration').toLowerCase();
    if (kind === 'addon' && offer?.addOnName) {
      return `You're all set. We've added ${offer.addOnName} to your appointment. See you soon.`;
    }
    if (kind === 'duration' && offer?.targetDurationMinutes) {
      return `You're all set. Your facial is now ${offer.targetDurationMinutes} minutes. See you soon.`;
    }
    return "You're all set. See you soon.";
  }
  return null; // caller decides the fallback copy via buildPendingOfferFinalizeReply
}
```

Then edit `src/app/api/sms/twilio/webhook/route.js`:
- Remove the inline `buildUpgradeApplyReply` definition (currently at line ~136).
- Add `import { buildUpgradeApplyReply as buildUpgradeApplyReplyCore } from '../../../../lib/sms-reply-copy.js';` near the top.
- Replace the call sites with a small wrapper that preserves the existing pending-offer fallback behavior:

```javascript
function buildUpgradeApplyReply(upgradeResult, opportunity, pendingOffer = null) {
  const successReply = buildUpgradeApplyReplyCore(upgradeResult, opportunity, pendingOffer);
  if (successReply) return successReply;
  return buildPendingOfferFinalizeReply(pendingOffer || opportunity);
}
```

- [ ] **Step 6.2: Write the test against the new pure module**

Create `__tests__/sms-reply-copy.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildUpgradeApplyReply } from '../src/lib/sms-reply-copy.js';

describe('buildUpgradeApplyReply success copy', () => {
  it('names the upgraded duration in the success reply', () => {
    const reply = buildUpgradeApplyReply(
      { success: true },
      { offerKind: 'duration', currentDurationMinutes: 30, targetDurationMinutes: 50 },
    );
    expect(reply).toContain('50 minutes');
    expect(reply).toContain("You're all set");
  });

  it('names the added addon in the success reply', () => {
    const reply = buildUpgradeApplyReply(
      { success: true },
      { offerKind: 'addon', addOnName: 'Antioxidant Peel' },
    );
    expect(reply).toContain('Antioxidant Peel');
    expect(reply).toContain("You're all set");
  });

  it('returns null when upgrade was not successful so caller can pick fallback copy', () => {
    expect(buildUpgradeApplyReply({ success: false }, { offerKind: 'duration' })).toBeNull();
  });
});
```

- [ ] **Step 6.3: Run tests, full suite, commit, PR, merge.**

```bash
npm test -- sms-reply-copy
npm test
git add src/lib/sms-reply-copy.js src/app/api/sms/twilio/webhook/route.js __tests__/sms-reply-copy.test.js
git commit -m "feat(sms): name the upgrade in confirmation reply

- Extract buildUpgradeApplyReply to src/lib/sms-reply-copy.js for unit testability.
- Success copy now names the new duration or addon so members know what changed.

Refs: docs/PLAN_sms-reactivation-2026-05-25.md Step 6"
git push -u origin <branch>
gh pr create --base main --title "feat(sms): name the upgrade in confirmation reply" --body "..."
```

---

## Final Verification (after Step 5 stabilizes for 7 days)

- [ ] **No ops-alert emails fired related to SMS automation for 7 consecutive days.**
- [ ] **Daily send volume returns toward pre-outage baseline** (3+ real sends/day on Boulevard upgrade path).
- [ ] **No `cancel_rebook_*` reason codes appear in production logs** (prod guard wall is still standing).
- [ ] **All 244+ Vitest tests pass on `main`.**
- [ ] **Close the SMS reactivation entry in `QA_ISSUES.md`** with the final summary.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | n/a (operational fix, not product scope) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | n/a (twice-reviewed during writing-plans) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 4 issues found, all 4 fixed |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI surface in this plan) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | n/a |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement starting at Step 0.

### Eng Review summary (2026-05-25)
- **Issue 1 (P1, fixed):** Branch 2a error-extraction path was wrong; rewrote to read `data.__error.errors[0].extensions.code` per the actual `fetchBoulevardGraphQL` return shape at `src/lib/boulevard.js:708-722`.
- **Issue 2 (P1, fixed):** Step 3 env-flip ordering rearranged so `SMS_ADDON_OFFERS_ENABLED=false` is set first, then `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=false`, then `SMS_CRON_ENABLED=true`.
- **Issue 3 (P2, fixed):** Added branches 2e (offer-expiry; defaults 15→60 min, 10→30 min reminder) and 2f (Klaviyo-gate cross-reference, diagnostic-only no-code-change).
- **Issue 4 (P2, fixed):** Step 2 split into PR β.5 (addon-only gate, ships first) and PR β (duration fix, ships second), per CLAUDE.md one-fix-per-PR rule.
- **CLAUDE.md adds:** Sentry is inert without DSN (Step 1a.2 short-circuits); cron only sends 9am-7pm ET (Step 3.5 verification rubric); Klaviyo gate flag is `SMS_REQUIRE_KLAVIYO_OPT_IN` (Step 2f.1 uses this).
