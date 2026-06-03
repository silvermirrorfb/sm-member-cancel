# PR A: Remove the destructive cancel-rebook fallback from the duration-upgrade path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the cancel-then-rebook fallback from the SMS duration-upgrade flow so a duration upgrade can never reach `cancelAppointment` under any environment or feature flag; on any failure of the safe in-place mutation it fails closed to the existing manual-follow-up path.

**Architecture:** The duration-upgrade apply path lives entirely in `src/lib/boulevard.js`. The safe primary mechanism is an in-place `updateAppointment` / `appointmentUpdate` GraphQL mutation that swaps the service to the longer-duration variant without ever cancelling. A destructive `tryApplyUpgradeViaCancelRebook` fallback (cancel + bookingCreate + bookingAddService + bookingComplete) sits behind it. We remove that fallback function and its single caller. The webhook layer already routes a failed apply to a queued support incident plus an approved "team will finalize" SMS reply, so fail-closed behavior needs no new code.

**Tech Stack:** Next.js 14 App Router, Node, Vitest. Boulevard Enterprise GraphQL. No new dependencies.

**Scope lock (do not cross):** Duration-upgrade path only. Do NOT touch the add-on path (`tryApplyAddonViaCancelRebook` at ~3473, its caller at ~3963) — that is PR B. Do NOT remove or rename any env var or the `ENABLE_CANCEL_REBOOK_FALLBACK` constant (still read by the add-on path) — that is PR C. One concern, one PR.

**Hard constraints:** Land via a merge commit, not squash. No `Co-Authored-By` trailers on commits or PR body. No em dashes anywhere (code, comments, tests, docs, commit messages, PR body).

**Branch base (decided in eng review):** Create the PR A branch from `origin/main`, NOT from the current `safe-addon-append` branch. `safe-addon-append` is one commit ahead of main (`6f7a37b`, the add-on PR-B red test) and carries the `2026-06-02-safe-addon-append.md` PR-B plan; branching PR A from it would inherit PR B's work and break one-fix-per-PR. PR A and PR B are independent (no shared code path after scope lock) and can land in any order; per Matt, PR A (live product path) lands first.
```bash
git fetch origin
git checkout -b fix/duration-upgrade-remove-cancel-rebook origin/main
```

---

## Pre-plan investigation findings (read-only, evidence-backed)

These answer the three required questions before any change is proposed.

### Q1. What is the PRIMARY duration-upgrade mechanism, and is cancel-rebook only a fallback?

The path from an inbound SMS "YES" to the Boulevard mutation:

1. `src/app/api/sms/twilio/webhook/route.js:733` — on an affirmative reply with a live pending offer, calls `reverifyAndApplyUpgradeForProfile(profile, pendingOffer)`.
2. `src/lib/boulevard.js` `reverifyAndApplyUpgradeForProfile` — for a duration offer (the add-on branch returns earlier when `offerKind === 'addon'`):
   - `boulevard.js:4015` re-evaluates eligibility via `evaluateUpgradeOpportunityForProfile`.
   - `boulevard.js:4031` gate: if `ENABLE_UPGRADE_MUTATION` is false, returns `upgrade_mutation_disabled` and never mutates.
   - `boulevard.js:4049-4055` resolves the target `serviceId` (`BOULEVARD_SERVICE_ID_50MIN` / `BOULEVARD_SERVICE_ID_90MIN`).
   - **`boulevard.js:4065` PRIMARY:** `tryApplyAppointmentUpgradeMutation(...)` runs the in-place `updateAppointment(input: { id, serviceId })` / `appointmentUpdate` mutation (definition `boulevard.js:2546-2585`). This swaps the service in place. It never cancels. If it fails it returns `{ applied: false, reason: 'upgrade_mutation_failed' }`.
   - **`boulevard.js:4066-4107` FALLBACK (to delete):** `if (!applied.applied && ENABLE_CANCEL_REBOOK_FALLBACK)` calls `tryApplyUpgradeViaCancelRebook` (definition `boulevard.js:2939-3241`), which fires `cancelAppointment` (mutation `CancelAppointmentForUpgrade`, `boulevard.js:2962`) and then rebooks.
   - **`boulevard.js:4108-4115` already-present fail-closed terminal:** `if (!applied.applied) { return { success: false, reason: 'upgrade_mutation_failed', ... } }`.

Conclusion: the in-place mutation is the primary mechanism. Cancel-rebook is purely a fallback. Evidence: `boulevard.js:4065` (primary), `4066-4107` (fallback, single caller), `4108-4115` (fail-closed terminal already exists).

### Q2. Does the safe primary fully cover duration upgrades, or does any case depend on the fallback?

The safe primary covers every duration upgrade the system actually applies. Precision (codex review): the only target the eligibility evaluator accepts today is 50-min; a 90-min target returns `unsupported_upgrade_target` upstream (`evaluateUpgradeOpportunityForProfile`, ~`boulevard.js:2377`) before the apply branch at `4049-4055` is reached, so the 90-min arm of the serviceId switch is currently unreachable regardless of this PR. The only situation in which cancel-rebook runs is: the in-place mutation returned `applied: false` AND the fallback is enabled. When the fallback is disabled the code already falls straight through to the fail-closed terminal at `boulevard.js:4108`.

Therefore deleting the fallback removes only the "destroy and recreate when the in-place swap fails" behavior. It loses **no production apply coverage** — the fallback is already disabled in production by the `NODE_ENV` guard (see Q3), so in prod the failed-apply case already returns `upgrade_mutation_failed` today. Outside production it intentionally trades the destructive fallback for fail-closed. Evidence: the `if (!applied.applied)` terminal at `4108-4115` already returns `upgrade_mutation_failed` for the fallback-disabled case today.

Out of scope but flagged (codex review): `tryApplyAppointmentUpgradeMutation` (`boulevard.js:2546-2585`) treats any returned appointment id as success without verifying the service/duration actually changed, so a Boulevard no-op mutation could still produce the "You're all set" reply. This is pre-existing behavior, not introduced or worsened by PR A, and adding post-update verification is a separate concern (one fix per PR). Captured as a TODO, not bundled here.

### Q3. What does `BOULEVARD_ENABLE_UPGRADE_MUTATION` gate, what is the fail-closed destination, and is the fallback already neutralized in production?

- `ENABLE_UPGRADE_MUTATION` (`boulevard.js:26`, gate at `4031`): when false, `reverifyAndApplyUpgradeForProfile` returns `upgrade_mutation_disabled` without calling any Boulevard mutation. The webhook has a matching earlier short-circuit: `canFinalizeWithoutMutation = hasPendingOffer && !isUpgradeMutationEnabled()` (`webhook/route.js:626`, helper at `:118`); when mutation is disabled and the reply is affirmative (`webhook/route.js:638`) it queues a support incident and replies with `buildPendingOfferFinalizeReply` (team will finalize). That is the manual-follow-up destination.
- **Fail-closed on a failed apply already routes to manual follow-up with no new code.** After the in-place mutation fails and (post-PR-A) the function returns `upgrade_mutation_failed`, the webhook calls `shouldQueueUpgradeFollowupIncident(upgradeResult)` (`webhook/route.js:200`), which returns `true` for any non-success result, so a support incident is queued; and `buildUpgradeApplyReply` (`webhook/route.js:192`) returns `buildPendingOfferFinalizeReply` for any non-success result. The appointment is untouched because the in-place mutation that returned `applied: false` made no change. No booking is ever cancelled.
- **CRITICAL FINDING — the fallback is ALREADY dead in production.** `boulevard.js:27-30`:
  ```js
  // Production SMS must never cancel an existing booking as an automatic fallback.
  const ENABLE_CANCEL_REBOOK_FALLBACK =
    process.env.NODE_ENV !== 'production' &&
    process.env.BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK === 'true';
  ```
  On Vercel `NODE_ENV === 'production'`, so `ENABLE_CANCEL_REBOOK_FALLBACK` is `false` regardless of the env var. The destructive duration cancel-rebook cannot execute in production today. PR A therefore removes **latent dead code**: it makes the guarantee unconditional ("never under any env or flag," not "never only because of a NODE_ENV check") and prevents a future refactor, a non-production deployment, or a change to line 29 from re-exposing the live wire. This is defense-in-depth excision, not an actively bleeding fix. The plan and PR body must describe it accurately and not overstate live-prod urgency.

### Bonus findings that shape the test work

- The committed test `__tests__/boulevard-addon-append-safety.test.js` (commit `6f7a37b`) is a TDD red test written ahead for **PR B** (add-on path). It is currently RED on `main` (it asserts the source no longer contains `tryApplyAddonViaCancelRebook`, which is still present). PR A must not touch it and must not be blocked by it. The focused-suite gate (Task 5) must exclude it as a known PR-B red.
- `__tests__/boulevard-cancel-rebook-notes.test.js` has two `describe` blocks, both green today:
  - First block `cancel-rebook note sync status` (lines 6-285): `beforeEach` sets the flag true and does NOT set `NODE_ENV` (vitest default, non-production), so the fallback is enabled; its single `it` asserts the destructive path SUCCEEDS (`applied_cancel_rebook_notes_sync_failed`, `success: true`). This behavior is exactly what PR A removes, so this block must be DELETED in PR A or it will fail.
  - Second block `production cancel-rebook fallback safety` (lines 287-499): `beforeEach` sets `NODE_ENV: 'production'`, so it passes today via the NODE_ENV guard, not because the fallback code is absent. It asserts `success: false`, `reason: 'upgrade_mutation_failed'`, `cancelCalled === false`. It stays green after PR A. KEEP it unchanged. Note: because it runs in production mode, it does NOT prove the deletion (it would pass even without PR A). The new test in Task 1 closes that gap by running in non-production with the flag on.

---

## File structure

- `src/lib/boulevard.js` — MODIFY. Delete the `tryApplyUpgradeViaCancelRebook` function and its single call site in `reverifyAndApplyUpgradeForProfile`. No other responsibility changes. Shared helpers (`runMutationRoot`, `toBoulevardNaiveDateTime`, `toBookingWarningList`, `hasBlockingBookingWarnings`, `trySyncAppointmentNotes`, `fetchAppointmentContextById`) stay — they are used by the add-on path (PR B) and elsewhere.
- `__tests__/boulevard-duration-upgrade-append-safety.test.js` — CREATE. Regression guard parallel to `boulevard-addon-append-safety.test.js`: a static-source assertion that the destructive duration symbols are gone, and a behavioral assertion that a failed in-place upgrade never cancels even with the fallback flag on in non-production.
- `__tests__/boulevard-cancel-rebook-notes.test.js` — MODIFY. Delete the first `describe` block (the destructive-success test that PR A invalidates). Keep the second block.
- `QA_ISSUES.md` — MODIFY. Add `outbound-sms #11` for the Maureen Golga 2026-05-20 incident, plus a one-line pointer in the "Currently open" section.

---

## Task 1: Add the duration-upgrade append-safety regression test (RED first)

**Files:**
- Create: `__tests__/boulevard-duration-upgrade-append-safety.test.js`

- [ ] **Step 1: Write the failing test**

Create `__tests__/boulevard-duration-upgrade-append-safety.test.js` with exactly this content. The behavioral mock is lifted verbatim from the known-good block at `__tests__/boulevard-cancel-rebook-notes.test.js:312-485`, with one deliberate change: `NODE_ENV` is `'test'` (non-production) while the fallback flag is `'true'`, so the ONLY thing that can stop a cancel is the code being deleted.

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const originalEnv = process.env;
const originalFetch = global.fetch;

describe('duration-upgrade append safety', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Non-production on purpose. With the fallback flag on, the only reason a
      // cancel must not fire is that the cancel-rebook code was deleted.
      NODE_ENV: 'test',
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
      BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK: 'true',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not keep destructive duration cancel-rebook code in boulevard.js', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, '../src/lib/boulevard.js'), 'utf8');

    expect(source).not.toContain('tryApplyUpgradeViaCancelRebook');
    expect(source).not.toContain('CancelAppointmentForUpgrade');
    expect(source).not.toContain('applied_cancel_rebook');
  });

  it('never calls cancelAppointment when the in-place duration upgrade fails, even with the fallback flag on outside production', async () => {
    let cancelCalled = false;

    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      const typeName = String(body?.variables?.typeName || '');

      if (query.includes('IntrospectType(')) {
        if (typeName === 'Query') {
          return { ok: true, json: async () => ({ data: { __type: { fields: [{ name: 'appointments' }] } } }) };
        }
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    { name: 'id' },
                    { name: 'startOn' },
                    { name: 'endOn' },
                    { name: 'clientId' },
                    { name: 'providerId' },
                    { name: 'locationId' },
                    { name: 'status' },
                    { name: 'canceledAt' },
                  ],
                },
              },
            }),
          };
        }
      }

      if (query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return {
            ok: true,
            json: async () => ({
              data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } },
            }),
          };
        }
        if (typeName === 'Query') {
          return {
            ok: true,
            json: async () => ({
              data: {
                __type: {
                  fields: [
                    {
                      name: 'appointments',
                      args: [
                        { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                        { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                      ],
                      type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
                    },
                  ],
                },
              },
            }),
          };
        }
      }

      if (query.includes('FetchAppointmentContext')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointment: {
                id: 'appt-1',
                clientId: 'client-1',
                locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                startAt: '2026-03-11T10:00:00.000Z',
                endAt: '2026-03-11T10:30:00.000Z',
                notes: 'Original internal note',
                appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
              },
            },
          }),
        };
      }

      if (query.includes('ScanAppointments')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              appointments: {
                edges: [
                  {
                    node: {
                      id: 'appt-1',
                      clientId: 'client-1',
                      providerId: 'prov-1',
                      locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                      startOn: '2026-03-11T10:00:00.000Z',
                      endOn: '2026-03-11T10:30:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                  {
                    node: {
                      id: 'appt-next',
                      clientId: 'other',
                      providerId: 'prov-1',
                      locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                      startOn: '2026-03-11T11:05:00.000Z',
                      endOn: '2026-03-11T11:35:00.000Z',
                      status: 'BOOKED',
                      canceledAt: null,
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }

      if (query.includes('mutation UpgradeAppointment') || query.includes('mutation UpgradeAppointmentAlt')) {
        return { ok: true, json: async () => ({ errors: [{ message: 'serviceId not supported in updateAppointment input' }] }) };
      }

      if (query.includes('CancelAppointmentForUpgrade') || query.includes('cancelAppointment')) {
        cancelCalled = true;
      }

      return { ok: true, json: async () => ({ data: {} }) };
    });

    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { offerKind: 'duration', appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-03-11T08:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('upgrade_mutation_failed');
    expect(cancelCalled).toBe(false);
    expect(
      global.fetch.mock.calls.some(([, init]) => String(JSON.parse(init.body).query || '').includes('CancelAppointmentForUpgrade')),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/boulevard-duration-upgrade-append-safety.test.js`
Expected: BOTH `it`s FAIL before the source change.
- The static test fails: source still contains `tryApplyUpgradeViaCancelRebook`.
- The behavioral test fails: with `NODE_ENV: 'test'` + flag true, the fallback runs, so `cancelCalled` becomes `true` AND `result.reason` is a `cancel_rebook_*` value (the cancel mutation is attempted; the mock returns `{ data: {} }` for it, so the pre-fix reason is specifically `cancel_rebook_cancel_failed`). The test's assertions encode the POST-fix green state (`upgrade_mutation_failed`, no cancel), so a `cancel_rebook_cancel_failed` reason pre-fix is the expected red, not a test bug. Note: the `cancelCalled` tracker keys on the GraphQL field `cancelAppointment` (not just the named operation `CancelAppointmentForUpgrade`), so it catches any cancel mutation a future refactor might introduce under a different operation name.

If the behavioral test does NOT fail (no cancel observed), STOP: the duration opportunity is not being evaluated as eligible by the mock. Diagnose against the known-good sibling at `boulevard-cancel-rebook-notes.test.js:309` before proceeding; do not weaken the assertions to make it pass.

- [ ] **Step 3: Commit the red test**

```bash
git add __tests__/boulevard-duration-upgrade-append-safety.test.js
git commit -m "test(sms): prove duration upgrade never cancels when in-place apply fails"
```

---

## Task 2: Delete the destructive duration cancel-rebook from boulevard.js (turn the test GREEN)

**Files:**
- Modify: `src/lib/boulevard.js` (remove function `tryApplyUpgradeViaCancelRebook` ~lines 2939-3241, and the fallback call block ~lines 4066-4107)

- [ ] **Step 1: Delete the `tryApplyUpgradeViaCancelRebook` function**

Remove the entire function. It begins at:
```js
async function tryApplyUpgradeViaCancelRebook(apiUrl, headers, opportunity, serviceId) {
```
and ends at its closing brace immediately before:
```js
function buildAddonReverifyResult(reason, opportunity = null, extra = {}) {
```
Delete the function and the blank line that separated it from `buildAddonReverifyResult`. Do NOT delete `buildAddonReverifyResult` or anything after it. Do NOT touch `tryApplyAddonViaCancelRebook` (add-on path, PR B).

- [ ] **Step 2: Delete the fallback call block in `reverifyAndApplyUpgradeForProfile`**

In `reverifyAndApplyUpgradeForProfile`, the duration apply currently reads:

```js
  const applied = await tryApplyAppointmentUpgradeMutation(auth.apiUrl, auth.headers, fresh.appointmentId, serviceId);
  if (!applied.applied && ENABLE_CANCEL_REBOOK_FALLBACK) {
    const appointmentContext = await fetchAppointmentContextById(auth.apiUrl, auth.headers, fresh.appointmentId);
    const fallbackOpportunity = {
      ...fresh,
      clientId: fresh.clientId || appointmentContext?.clientId || null,
      locationId: fresh.locationId || appointmentContext?.locationId || null,
      providerId: fresh.providerId || appointmentContext?.providerId || null,
      startOn: fresh.startOn || appointmentContext?.startOn || null,
      endOn: fresh.endOn || appointmentContext?.endOn || null,
      notes: appointmentContext?.notes || null,
    };
    const cancelRebookApplied = await tryApplyUpgradeViaCancelRebook(
      auth.apiUrl,
      auth.headers,
      fallbackOpportunity,
      serviceId,
    );
    if (cancelRebookApplied.applied) {
      const notesSyncFailed = Boolean(
        cancelRebookApplied?.notesSync &&
        cancelRebookApplied.notesSync.skipped !== true &&
        cancelRebookApplied.notesSync.applied !== true,
      );
      return {
        success: true,
        reason: notesSyncFailed ? 'applied_cancel_rebook_notes_sync_failed' : 'applied_cancel_rebook',
        reverified: true,
        opportunity: fresh,
        mutationRoot: cancelRebookApplied.mutationRoot,
        updatedAppointmentId: cancelRebookApplied.updatedId,
        canceledAppointmentId: cancelRebookApplied.canceledAppointmentId || fresh.appointmentId || null,
        bookingId: cancelRebookApplied.bookingId || null,
        notesSync: cancelRebookApplied.notesSync || null,
      };
    }
    return {
      success: false,
      reason: cancelRebookApplied.reason || applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }
  if (!applied.applied) {
    return {
      success: false,
      reason: applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }
```

Replace that whole span with the safe-only version (delete the `&& ENABLE_CANCEL_REBOOK_FALLBACK` branch entirely):

```js
  const applied = await tryApplyAppointmentUpgradeMutation(auth.apiUrl, auth.headers, fresh.appointmentId, serviceId);
  if (!applied.applied) {
    return {
      success: false,
      reason: applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }
```

Leave the trailing success return (`reason: 'applied'`) exactly as-is. Do NOT remove the `ENABLE_CANCEL_REBOOK_FALLBACK` constant declaration at the top of the file; the add-on path still reads it (PR B removes its add-on use, PR C removes the constant).

- [ ] **Step 3: Run the new regression test to verify it passes**

Run: `npx vitest run __tests__/boulevard-duration-upgrade-append-safety.test.js`
Expected: BOTH `it`s PASS. Static: the duration symbols are gone. Behavioral: `result.reason === 'upgrade_mutation_failed'`, `cancelCalled === false`.

- [ ] **Step 4: Verify no other source reference to the deleted symbols remains**

Run: `grep -rnE "tryApplyUpgradeViaCancelRebook|CancelAppointmentForUpgrade|BookingCreateForUpgrade|BookingAddServiceForUpgrade|BookingCompleteForUpgrade|BookingSetClientForUpgrade" src/`
Expected: no matches. (Add-on-prefixed symbols like `CancelAppointmentForAddon` are untouched and out of scope.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/boulevard.js
git commit -m "fix(sms): remove cancel-rebook fallback from duration upgrade so it never cancels a booking"
```

---

## Task 3: Remove the now-invalid destructive-success test case

**Files:**
- Modify: `__tests__/boulevard-cancel-rebook-notes.test.js` (delete the first `describe` block, lines 6-285)

- [ ] **Step 1: Delete the first `describe` block**

Delete the entire block:
```js
describe('cancel-rebook note sync status', () => {
  ...
  it('surfaces notes sync failure reason after successful cancel+rebook apply', async () => {
    ...
    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied_cancel_rebook_notes_sync_failed');
    expect(result.notesSync).toMatchObject({ ... });
  });
});
```
This block asserts the destructive cancel-rebook succeeds, which PR A removes. Keep the imports/`originalEnv`/`originalFetch` setup at the top of the file and keep the second `describe('production cancel-rebook fallback safety', ...)` block unchanged.

- [ ] **Step 2: Run the file to verify the remaining block passes**

Run: `npx vitest run __tests__/boulevard-cancel-rebook-notes.test.js`
Expected: PASS. Only the `production cancel-rebook fallback safety` block remains, asserting `success: false`, `reason: 'upgrade_mutation_failed'`, `cancelCalled === false`. It still passes (now because the code is gone, previously because of the NODE_ENV guard).

- [ ] **Step 3: Commit**

```bash
git add __tests__/boulevard-cancel-rebook-notes.test.js
git commit -m "test(sms): drop duration cancel-rebook success case removed by the safe-only upgrade path"
```

---

## Task 4: Log the production incident in QA_ISSUES.md

**Files:**
- Modify: `QA_ISSUES.md` (add `### outbound-sms #11`; add a one-line pointer under "Currently open at the top of the list")

- [ ] **Step 1: Add the issue entry**

Insert a new entry immediately after the `### outbound-sms #10` block (before the `---` that precedes `## Cancel bot issues`):

```markdown
### outbound-sms #11
**Status:** FIXED IN CODE 2026-06-03 (PR A, duration-upgrade path). Add-on path tracked separately (PR B). Bump to VERIFIED FIXED after merge + production deploy.
**Severity:** customer-harm
**Discovered:** 2026-05-20 (member-reported lost booking)

**Symptom:** On 2026-05-20 a real member (Maureen Golga) had a booked appointment destroyed by the outbound-SMS upgrade flow. The flow cancelled the existing appointment and then failed to create the replacement, leaving the member with no appointment and the freed slot available to others. There was no transaction wrapping the two steps and no rollback.

**Root cause:** The add-on and duration apply flows each carried a destructive cancel-then-rebook fallback (`tryApplyAddonViaCancelRebook`, `tryApplyUpgradeViaCancelRebook` in `src/lib/boulevard.js`). When the safe in-place apply failed and the fallback was enabled, the code ran `cancelAppointment` first and then attempted `bookingCreate`; any failure after the cancel left the booking permanently gone with no recovery path.

**Mitigation already in place:** `ENABLE_CANCEL_REBOOK_FALLBACK` is gated `process.env.NODE_ENV !== 'production'` (`boulevard.js:27-30`), so the destructive fallback cannot run in production today. That neutralizes the live risk but leaves the destructive code reachable in non-production and one edit away from re-exposure.

**Fix (PR A, this entry):** Remove the duration-upgrade cancel-rebook fallback entirely (`tryApplyUpgradeViaCancelRebook` and its single caller in `reverifyAndApplyUpgradeForProfile`). A duration upgrade can now only apply via the safe in-place `updateAppointment` mutation; on any failure it fails closed (`upgrade_mutation_failed`), which the webhook routes to a queued support incident plus the approved finalize-by-team SMS reply, leaving the appointment untouched. Regression test: `__tests__/boulevard-duration-upgrade-append-safety.test.js` (static-source guard plus a behavioral guard that runs with the fallback flag on in non-production and asserts no cancel). The add-on path fallback removal is PR B; removing the now-unused env var is PR C.

**Verify post-deploy:** confirm `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` is off in production (`vercel env ls production --scope silver-mirror-projects`), and confirm a forced in-place failure routes a duration YES to a support incident and the finalize reply with the original appointment intact.
```

- [ ] **Step 2: Add the one-line pointer under "Currently open"**

Under `## Currently open at the top of the list`, add:

```markdown
**Member-harm incident on record:**

- **outbound-sms #11** - Real member (Maureen Golga, 2026-05-20) lost a booked appointment to the destructive cancel-rebook fallback. Production is already guarded by the `NODE_ENV !== 'production'` check; PR A removes the duration-upgrade fallback code outright, PR B the add-on fallback, PR C the now-unused env var.
```

- [ ] **Step 3: Commit**

```bash
git add QA_ISSUES.md
git commit -m "docs(qa): log outbound-sms #11 Maureen Golga lost-booking incident and PR A fix"
```

---

## Task 5: Confirm the focused suite is green and open the PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the focused duration/upgrade suite**

Run the upgrade-related and webhook test files:
```bash
npx vitest run \
  __tests__/boulevard-duration-upgrade-append-safety.test.js \
  __tests__/boulevard-cancel-rebook-notes.test.js \
  __tests__/upgrade-route.test.js \
  __tests__/upgrade-check-route.test.js \
  __tests__/sms-upgrade-scan-route.test.js \
  __tests__/twilio-webhook-route.test.js \
  __tests__/sms-automation-route.test.js \
  __tests__/boulevard.test.js
```
Expected: all green. Matt's reference figure is 39/39 focused tests; confirm the count and that none are red. If the precise file set does not total 39, adjust the file list to the upgrade-focused set rather than changing assertions; record the actual count in the PR body.

- [ ] **Step 2: Confirm the full suite is green on the clean PR-A branch**

Run: `npx vitest run`
Expected: ALL GREEN. Because PR A branches from `origin/main` (not `safe-addon-append`), the ahead-of-time PR-B test `__tests__/boulevard-addon-append-safety.test.js` and its `6f7a37b` commit are NOT present, so there is no known red to tolerate. If `boulevard-addon-append-safety.test.js` shows up red, that is a signal the branch was wrongly cut from `safe-addon-append`; re-cut from `origin/main`. If any other file is red, stop and investigate before opening the PR.

- [ ] **Step 3: Push the branch and open the PR (merge commit, no squash, no co-author trailer, no em dashes)**

```bash
git push -u origin <branch>
gh pr create --title "fix(sms): remove cancel-rebook fallback from the duration-upgrade path (outbound-sms #11, PR A)" --body "$(cat <<'EOF'
PR A of a three-PR series hardening the SMS upgrade/add-on apply flow against the outbound-sms #11 lost-booking incident.

What this does:
- Deletes tryApplyUpgradeViaCancelRebook and its single caller in reverifyAndApplyUpgradeForProfile so a duration upgrade can never reach cancelAppointment under any env or flag.
- On any failure of the safe in-place updateAppointment mutation the flow fails closed (upgrade_mutation_failed), which the webhook already routes to a queued support incident plus the approved finalize-by-team reply, leaving the appointment untouched.

Context:
- The fallback was already disabled in production by the NODE_ENV check at boulevard.js:27-30, so this removes latent code and makes the no-cancel guarantee unconditional.

Tests:
- New __tests__/boulevard-duration-upgrade-append-safety.test.js: static-source guard plus a behavioral guard that runs with the fallback flag on in non-production and asserts no cancel.
- Removed the now-invalid destructive-success case from boulevard-cancel-rebook-notes.test.js; the production-safety case stays green.
- Known expected red: __tests__/boulevard-addon-append-safety.test.js is an ahead-of-time test for PR B (add-on path) and stays red until PR B lands.

Scope lock: duration-upgrade path only. Add-on fallback is PR B. Env-var removal is PR C.
EOF
)"
```

- [ ] **Step 4: Merge as a merge commit (not squash) after review and CI**

This is the integration constraint, executed at land time, not now: merge via merge commit, no squash.

---

## Self-review

**1. Spec coverage.** Matt's deliverables mapped to tasks:
- Exact lines to delete for the duration path — Task 2 (function at ~2939-3241; fallback block at ~4066-4107, shown with before/after).
- Fail-closed behavior on safe-path failure (route to manual follow-up, no cancel) — documented in Q3; achieved by deletion plus the existing webhook routing; no new code.
- Regression test parallel to `boulevard-addon-append-safety.test.js` proving safe-path failure never cancels and fails closed, plus a static check that no cancel-rebook is reachable from the duration path — Task 1.
- QA_ISSUES.md entry for the Maureen Golga incident in this PR — Task 4.
- Confirm existing focused tests stay green (Matt's 39/39) — Task 5. On a clean branch from `origin/main` the full suite is green; the PR-B `boulevard-addon-append-safety.test.js` red does not exist on that base (it lives only on `safe-addon-append`).
- Constraints (merge not squash, no co-author trailers, no em dashes) — header plus Task 5.

**2. Placeholder scan.** No TODO/TBD/"handle edge cases"/"similar to" placeholders. The one place that defers is the focused-suite count (Matt's 39): handled by instructing the implementer to confirm the count and record the actual number rather than fabricating one. Line numbers are given as "approximately" and paired with unique anchor text because deleting the function shifts the later block upward.

**3. Type/name consistency.** Symbols are consistent across tasks: `tryApplyUpgradeViaCancelRebook`, `tryApplyAppointmentUpgradeMutation`, `reverifyAndApplyUpgradeForProfile`, `ENABLE_CANCEL_REBOOK_FALLBACK`, reasons `upgrade_mutation_failed` / `applied`. The static test greps the upgrade-specific names only (`tryApplyUpgradeViaCancelRebook`, `CancelAppointmentForUpgrade`, `applied_cancel_rebook`), which do not collide with the add-on names that remain after PR A (`tryApplyAddonViaCancelRebook`, `CancelAppointmentForAddon`, `applied_addon_cancel_rebook` — none contain the substring `applied_cancel_rebook`).

---

## What already exists (reuse, do not rebuild)

- **Safe in-place apply mechanism** — `tryApplyAppointmentUpgradeMutation` (`boulevard.js:2546-2585`). The duration upgrade already applies via `updateAppointment` / `appointmentUpdate` in place. PR A keeps it as the sole apply path; nothing to build.
- **Fail-closed routing** — `webhook/route.js:192` (`buildUpgradeApplyReply`) and `:200` (`shouldQueueUpgradeFollowupIncident`) already queue a support incident and send the approved finalize-by-team reply for any non-success result. PR A reuses this; no new manual-follow-up code.
- **Production safety guard** — `boulevard.js:27-30` already disables the fallback when `NODE_ENV === 'production'`. PR A makes the guarantee unconditional; it does not change production behavior.
- **Regression-test scaffolding** — `__tests__/boulevard-addon-append-safety.test.js` (PR B) and `__tests__/boulevard-cancel-rebook-notes.test.js` (existing) supply the exact mock shape; the new test is modeled on them rather than written from scratch.

## NOT in scope (considered and deferred)

- **Add-on cancel-rebook removal** (`tryApplyAddonViaCancelRebook`, caller at `boulevard.js:3963`) — PR B. Same destructive pattern, separate code path; one fix per PR.
- **Removing `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` and the `ENABLE_CANCEL_REBOOK_FALLBACK` constant** — PR C. The constant is still read by the add-on path until PR B lands.
- **Post-update verification of the in-place mutation** — captured in `TODOS.md`. PR A is "never cancel"; verifying the apply actually changed the booking is a distinct concern.
- **`buildUpgradeApplyReply` / incident copy changes** — fail-closed routing already works; no copy change needed.

## Failure modes (surviving duration path after PR A)

| Codepath | Realistic production failure | Test covers it | Error handling exists | User sees |
|---|---|---|---|---|
| `tryApplyAppointmentUpgradeMutation` returns `applied:false` | Boulevard timeout / 500 / schema drift on `updateAppointment` | Yes (new behavioral test + retained prod-safety test) | Yes (`upgrade_mutation_failed` to webhook routing) | Approved finalize-by-team SMS + queued support incident; appointment untouched |
| `tryApplyAppointmentUpgradeMutation` returns `applied:true` on a Boulevard no-op | Mutation accepted but duration not actually changed | No (pre-existing gap, see TODOS.md) | No | "You're all set" while booking unchanged |

The second row is a **pre-existing** silent-failure mode, not introduced by PR A, and is flagged in `TODOS.md`. PR A neither creates nor worsens it.

## Worktree parallelization

Sequential implementation, no parallelization opportunity. All tasks touch the same primary module (`src/lib/boulevard.js`) and its tests; the QA doc and TODO are trivial. Run the tasks in order in one branch.

## Implementation Tasks

Synthesized from review findings. Each derives from a specific finding above.

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — branch hygiene — cut PR A from `origin/main`, not `safe-addon-append`
  - Surfaced by: Architecture review — branch `safe-addon-append` is one commit ahead of main with PR-B work
  - Files: n/a (git)
  - Verify: `git log --oneline origin/main..HEAD` shows only PR-A commits
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — boulevard.js — delete `tryApplyUpgradeViaCancelRebook` + its caller block; new behavioral + static safety test green
  - Surfaced by: Test review + plan goal
  - Files: `src/lib/boulevard.js`, `__tests__/boulevard-duration-upgrade-append-safety.test.js`
  - Verify: `npx vitest run __tests__/boulevard-duration-upgrade-append-safety.test.js`
- [ ] **T3 (P2, human: ~20min / CC: ~5min)** — tests — remove the stale destructive-success case from `boulevard-cancel-rebook-notes.test.js`
  - Surfaced by: Test review — first describe asserts behavior PR A removes
  - Files: `__tests__/boulevard-cancel-rebook-notes.test.js`
  - Verify: `npx vitest run __tests__/boulevard-cancel-rebook-notes.test.js`
- [ ] **T4 (P2, human: ~15min / CC: ~5min)** — docs — QA_ISSUES.md outbound-sms #11 entry
  - Surfaced by: plan requirement (incident not on record)
  - Files: `QA_ISSUES.md`
  - Verify: grep `outbound-sms #11` present
- [ ] **T5 (P3, human: ~2h / CC: ~20min)** — boulevard.js — post-update verification of the in-place mutation (follow-up, see TODOS.md)
  - Surfaced by: codex outside-voice review
  - Files: `src/lib/boulevard.js`
  - Verify: new test asserts a Boulevard no-op response fails closed

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (bug-fix, not a product change) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 plan-accuracy corrections, 0 critical gaps |
| Outside Voice | codex | Independent 2nd opinion | 1 | issues_found | 3 overclaims corrected, 1 pre-existing issue flagged to TODO |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI) |

- **CODEX:** validated the core ("deleting the duration cancel-rebook is coherent for never cancel"); flagged that the plan overclaimed full upgrade coverage (90-min is gated upstream), that the remaining apply path lacks post-update verification, and that deletion removes apply capability outside production. All folded in.
- **CROSS-MODEL:** no tension on approach. Both the review and codex agree deletion is safe for the "never cancel" guarantee. Codex only tightened accuracy claims, now corrected in the plan.
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED. Plan is ready to implement (build not started, per instruction). Branch from `origin/main` first.
