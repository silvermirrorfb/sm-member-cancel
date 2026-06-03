# PR B: Remove the destructive cancel-rebook fallback from the add-on path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the cancel-then-rebook fallback from the SMS add-on apply flow so an add-on apply can never reach `cancelAppointment` under any environment or feature flag; on any failure of the safe in-place append it fails closed to the same manual-follow-up path PR A confirmed live-wired. This mirrors PR A (#47, merged at 59f2607) on the add-on side.

**Architecture:** The add-on apply path lives in `src/lib/boulevard.js` inside `reverifyAndApplyUpgradeForProfile` (add-on branch). The SAFE primary mechanism is `tryApplyAddonViaBookingFromAppointment` (`bookingCreateFromAppointment` then `bookingAddServiceAddon` then `bookingComplete`), which edits the existing appointment and never cancels. A destructive `tryApplyAddonViaCancelRebook` (cancel then bookingCreate then re-add services then complete) sits behind it as a flag-gated fallback. We remove that fallback function and its single caller block, leaving the existing fail-closed terminal as the only failure path. The webhook already routes a failed apply to a queued support incident plus the approved finalize-by-team SMS reply, so fail-closed needs no new code.

**Tech Stack:** Next.js 14 App Router, Node, Vitest. Boulevard Enterprise GraphQL. No new dependencies.

**Scope lock (do not cross):** Add-on path only. Do NOT touch the duration path (already done in PR A). Do NOT remove or rename `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` or the `ENABLE_CANCEL_REBOOK_FALLBACK` constant (that is PR C; after PR B the constant becomes unreferenced, which PR C removes). One concern, one PR.

**Hard constraints:** Land via a merge commit, not squash. No `Co-Authored-By` trailers on commits or PR body. No em dashes anywhere (code, comments, tests, docs, commit messages, PR body).

---

## Branch strategy (decided first)

State of the world: `main` is at `59f2607` (PR A merged, duration cancel-rebook gone). The PR-B red test (`__tests__/boulevard-addon-append-safety.test.js`) and the older `2026-06-02-safe-addon-append.md` plan live on the local `safe-addon-append` branch, which was cut from the OLD main (`8ea19cc`) and does NOT contain PR A.

Evidence gathered:
- `safe-addon-append` is LOCAL ONLY: `git ls-remote --heads origin safe-addon-append` returns nothing, and `gh pr list --head safe-addon-append` returns `[]`. No push, no open PR, so rewriting or abandoning it costs nothing.
- It has exactly one commit beyond old main: `6f7a37b test(sms): prove add-on append failures never cancel appointments`. That commit adds ONLY the new test file (no `boulevard.js` change).
- That test file does NOT exist on current `main` (PR A did not include it), so replaying `6f7a37b` onto current `main` is a clean add with zero conflict.
- The `2026-06-02-safe-addon-append.md` plan file is untracked (not committed on the branch), so it does not travel with a cherry-pick or rebase; this PR-B plan supersedes it.

Decision: **cut a fresh branch from `origin/main` and cherry-pick the existing red test commit.** Preferred over rebasing `safe-addon-append` because it gives an unambiguous base (current main WITH PR A), uses a clear PR-B branch name, preserves the already-written red test verbatim, and avoids carrying the stale branch name. The cherry-pick is conflict-free (new file).

```bash
git fetch origin
git checkout -b fix/addon-remove-cancel-rebook origin/main
git cherry-pick 6f7a37b   # brings __tests__/boulevard-addon-append-safety.test.js over verbatim
```

Alternative (equivalent result, not preferred): `git checkout safe-addon-append && git rebase origin/main`. Also conflict-free since the only commit adds a new file, but keeps the stale branch name. Use only if you specifically want to preserve that branch.

Red-test assertion still correct after PR A merged: the test asserts the source no longer contains `tryApplyAddonViaCancelRebook`, `CancelAppointmentForAddon`, `applied_addon_cancel_rebook`. On current `main` those add-on symbols still exist (`boulevard.js:3169`, `:3198`, `:3675-3676`), so the test is correctly RED today and turns green only when PR B deletes them. Confirmed accurate.

---

## Pre-plan investigation findings (read-only, evidence-backed)

### Q1. What is the add-on PRIMARY mechanism, and is cancel-rebook only a fallback?

Path from an inbound SMS "YES" to the add-on apply:

1. `src/app/api/sms/twilio/webhook/route.js:733` calls `reverifyAndApplyUpgradeForProfile(profile, pendingOffer)` on an affirmative reply with a live pending offer.
2. `src/lib/boulevard.js` `reverifyAndApplyUpgradeForProfile` (now at `:3551`), add-on branch (entered when `pendingOffer.offerKind === 'addon'`):
   - Re-verifies the appointment, the 50-minute requirement, the gap, the `ENABLE_UPGRADE_MUTATION` gate, and resolves the add-on service id.
   - **`boulevard.js:3638` PRIMARY:** `tryApplyAddonViaBookingFromAppointment(...)` (definition `:2963-3168`). Uses `bookingCreateFromAppointment` then `bookingAddServiceAddon` then `bookingComplete`. It edits the existing appointment and never cancels. On success returns `applied_addon_booking_from_appointment`.
   - **`boulevard.js:3659-3698` FALLBACK (to delete):** `if (ENABLE_CANCEL_REBOOK_FALLBACK)` calls `tryApplyAddonViaCancelRebook(...)` (definition `:3169-3549`), which fires `cancelAppointment` (mutation `CancelAppointmentForAddon`, `:3198`) and then rebooks.
   - **`boulevard.js:3700-3708` already-present fail-closed terminal:** `return { success: false, reason: bookingFromAppointmentApplied.reason || 'addon_mutation_failed', ... }`.

Conclusion: the in-place append is the primary mechanism. Cancel-rebook is purely a fallback gated behind `ENABLE_CANCEL_REBOOK_FALLBACK`. Evidence: `boulevard.js:3638` (primary), `:3659-3698` (fallback, single caller), `:3700-3708` (fail-closed terminal already exists).

### Q2. Does the safe append fully cover add-on applies, or does any case depend on the fallback?

The safe append fully covers add-on applies. The only situation in which cancel-rebook runs is: the append returned `applied: false` AND the fallback is enabled. When the fallback is disabled the code already falls straight to the fail-closed terminal at `:3700`. No add-on apply case depends on the fallback firing. Deleting it loses no production apply coverage: the fallback is already disabled in production by the `NODE_ENV !== 'production'` gate on `ENABLE_CANCEL_REBOOK_FALLBACK` (`boulevard.js:28-30`), exactly as confirmed for PR A. Outside production it intentionally trades the destructive fallback for fail-closed.

### Q3. What does the false branch do for add-ons, and does failing closed route to the same live-wired manual follow-up?

When the fallback is absent and the append fails, `reverifyAndApplyUpgradeForProfile` returns `{ success: false, reason: 'addon_booking_from_appointment_failed' }` (or `addon_mutation_failed`). Back in the webhook (`route.js:735`), `shouldQueueUpgradeFollowupIncident(upgradeResult)` returns `true` for any non-success result, so a support incident is queued via `queueSupportIncident` then `logSupportIncident` (`notify.js:1033`, which sends an email AND logs to Google Sheets via `Promise.allSettled` — verified live-wired during PR A, not a no-op). `buildUpgradeApplyReply` (`route.js:192-197`) returns `buildPendingOfferFinalizeReply` for any non-success result, which for an add-on returns approved copy ("Thanks, we got your YES... our team will confirm before your appointment", `route.js:170-183`). The appointment is untouched because the append that returned `applied: false` made no change. This is the same fail-closed destination PR A confirmed.

### Bonus findings that shape the work

- **No stale destructive-success test to remove.** `grep -rln "applied_addon_cancel_rebook|CancelAppointmentForAddon|tryApplyAddonViaCancelRebook" __tests__/` returns nothing. PR A had to delete a duration destructive-success block from `boulevard-cancel-rebook-notes.test.js`; PR B has no equivalent. (That file was duration-only and was already cleaned in PR A.)
- **Two helpers become dead code after this deletion.** `tryApplyAddonViaCancelRebook` is the SOLE remaining caller of two helpers (PR A already removed their duration callers):
  - `trySyncAppointmentNotes` (def `:2861`, sole caller `:3539`).
  - `toBoulevardNaiveDateTime` (def `:2808`, sole caller `:3174`).
  Both are not exported and have no references outside `boulevard.js` or in `__tests__/` (verified). After PR B deletes `tryApplyAddonViaCancelRebook` they have zero callers. Removing them is cleanup of this change's own fallout (Karpathy: remove functions YOUR change made unused), so it belongs in PR B, in a separate commit for reviewability. `getPrimaryAppointmentService` stays: its non-definition caller (`:3033`) is inside the safe append, not the cancel-rebook.

---

## File structure

- `src/lib/boulevard.js` — MODIFY. Delete `tryApplyAddonViaCancelRebook` and its single caller block in `reverifyAndApplyUpgradeForProfile`; then delete the two helpers that this deletion orphans (`trySyncAppointmentNotes`, `toBoulevardNaiveDateTime`). Shared helpers used by the safe append (`runMutationRoot`, `toBookingWarningList`, `hasBlockingBookingWarnings`, `getPrimaryAppointmentService`) stay.
- `__tests__/boulevard-addon-append-safety.test.js` — BROUGHT OVER via cherry-pick of `6f7a37b`. No edits; it is the red-to-green guard.
- `QA_ISSUES.md` — MODIFY. Update the `outbound-sms #11` entry to record that the add-on path is now also fixed in code (PR B), parallel to how PR A recorded the duration path.

---

## Task 1: Cut the branch and bring the red test over (RED first)

**Files:**
- Create (via cherry-pick): `__tests__/boulevard-addon-append-safety.test.js`

- [ ] **Step 1: Cut the branch from current main and cherry-pick the red test**

```bash
git fetch origin
git checkout -b fix/addon-remove-cancel-rebook origin/main
git cherry-pick 6f7a37b
```
Expected: clean cherry-pick (the test file is a new add, absent on current main). If git reports a conflict, STOP: the branch base is wrong; confirm you branched from `origin/main` at `59f2607`.

- [ ] **Step 2: Run the test to verify it FAILS (both halves)**

Run: `npx vitest run __tests__/boulevard-addon-append-safety.test.js`
Expected: BOTH `it`s FAIL.
- Static test fails: source still contains `tryApplyAddonViaCancelRebook`.
- Behavioral test fails: with `NODE_ENV: 'test'` + `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK: 'true'`, the failed append enters the `if (ENABLE_CANCEL_REBOOK_FALLBACK)` block, `tryApplyAddonViaCancelRebook` fires `CancelAppointmentForAddon`, so `cancelCalled` becomes `true` and `result.reason` is a `addon_cancel_rebook_*` value rather than the asserted `addon_booking_from_appointment_failed`. The assertions encode the POST-fix green state, so this red is expected, not a test bug.

(No commit needed here; the cherry-pick already committed `6f7a37b`.)

---

## Task 2: Delete the destructive add-on cancel-rebook (turn the test GREEN)

**Files:**
- Modify: `src/lib/boulevard.js`

- [ ] **Step 1: Delete the `tryApplyAddonViaCancelRebook` function**

Remove the entire function. It begins at:
```js
async function tryApplyAddonViaCancelRebook(apiUrl, headers, appointmentContext, addOnServiceId) {
```
and ends at its closing brace immediately before:
```js
async function reverifyAndApplyUpgradeForProfile(profile, pendingOffer, options = {}) {
```
Delete the function and the blank line separating it from `reverifyAndApplyUpgradeForProfile`. Do NOT touch `tryApplyAddonViaBookingFromAppointment` (the safe append) or `reverifyAndApplyUpgradeForProfile` itself beyond Step 2.

- [ ] **Step 2: Delete the fallback call block in `reverifyAndApplyUpgradeForProfile`**

In the add-on branch, the apply currently reads:

```js
    const bookingFromAppointmentApplied = await tryApplyAddonViaBookingFromAppointment(
      auth.apiUrl,
      auth.headers,
      appointmentContext,
      addOnService.id,
    );
    if (bookingFromAppointmentApplied.applied) {
      return {
        success: true,
        reason: 'applied_addon_booking_from_appointment',
        reverified: true,
        opportunity: {
          ...mergedOpportunity,
          addOnServiceId: addOnService.id,
        },
        mutationRoot: bookingFromAppointmentApplied.mutationRoot,
        updatedAppointmentId: bookingFromAppointmentApplied.updatedId || appointmentId,
        bookingId: bookingFromAppointmentApplied.bookingId || null,
      };
    }

    if (ENABLE_CANCEL_REBOOK_FALLBACK) {
      const cancelRebookApplied = await tryApplyAddonViaCancelRebook(
        auth.apiUrl,
        auth.headers,
        appointmentContext,
        addOnService.id,
      );
      if (cancelRebookApplied.applied) {
        const notesSyncFailed = Boolean(
          cancelRebookApplied?.notesSync &&
          cancelRebookApplied.notesSync.skipped !== true &&
          cancelRebookApplied.notesSync.applied !== true,
        );
        return {
          success: true,
          reason: notesSyncFailed
            ? 'applied_addon_cancel_rebook_notes_sync_failed'
            : 'applied_addon_cancel_rebook',
          reverified: true,
          opportunity: {
            ...mergedOpportunity,
            addOnServiceId: addOnService.id,
          },
          mutationRoot: cancelRebookApplied.mutationRoot,
          updatedAppointmentId: cancelRebookApplied.updatedId || appointmentId,
          canceledAppointmentId: cancelRebookApplied.canceledAppointmentId || appointmentId,
          bookingId: cancelRebookApplied.bookingId || null,
          notesSync: cancelRebookApplied.notesSync || null,
        };
      }
      return {
        success: false,
        reason: cancelRebookApplied.reason || bookingFromAppointmentApplied.reason || 'addon_mutation_failed',
        reverified: true,
        opportunity: {
          ...mergedOpportunity,
          addOnServiceId: addOnService.id,
        },
      };
    }

    return {
      success: false,
      reason: bookingFromAppointmentApplied.reason || 'addon_mutation_failed',
      reverified: true,
      opportunity: {
        ...mergedOpportunity,
        addOnServiceId: addOnService.id,
      },
    };
  }
```

Delete the entire `if (ENABLE_CANCEL_REBOOK_FALLBACK) { ... }` block so the safe-append failure falls straight through to the final terminal. Result:

```js
    const bookingFromAppointmentApplied = await tryApplyAddonViaBookingFromAppointment(
      auth.apiUrl,
      auth.headers,
      appointmentContext,
      addOnService.id,
    );
    if (bookingFromAppointmentApplied.applied) {
      return {
        success: true,
        reason: 'applied_addon_booking_from_appointment',
        reverified: true,
        opportunity: {
          ...mergedOpportunity,
          addOnServiceId: addOnService.id,
        },
        mutationRoot: bookingFromAppointmentApplied.mutationRoot,
        updatedAppointmentId: bookingFromAppointmentApplied.updatedId || appointmentId,
        bookingId: bookingFromAppointmentApplied.bookingId || null,
      };
    }

    return {
      success: false,
      reason: bookingFromAppointmentApplied.reason || 'addon_mutation_failed',
      reverified: true,
      opportunity: {
        ...mergedOpportunity,
        addOnServiceId: addOnService.id,
      },
    };
  }
```

Do NOT remove the `ENABLE_CANCEL_REBOOK_FALLBACK` constant declaration; PR C removes it.

- [ ] **Step 3: Run the regression test to verify it PASSES**

Run: `npx vitest run __tests__/boulevard-addon-append-safety.test.js`
Expected: BOTH `it`s PASS. Static: the add-on destructive symbols are gone. Behavioral: `result.reason === 'addon_booking_from_appointment_failed'`, `cancelCalled === false`.

- [ ] **Step 4: Verify no other source reference to the deleted add-on symbols remains**

Run: `grep -rnE "tryApplyAddonViaCancelRebook|CancelAppointmentForAddon|BookingCreateForAddon|BookingAddBaseServiceForAddon|BookingAddServiceAddonForCancelRebook|applied_addon_cancel_rebook" src/`
Expected: no matches. (Duration symbols were already removed in PR A; the safe append's `BookingAddServiceAddonForSms` mutation is a different, retained operation.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/boulevard.js
git commit -m "fix(sms): remove cancel-rebook fallback from add-on apply so it never cancels a booking"
```

---

## Task 3: Remove the helpers this deletion orphaned

**Files:**
- Modify: `src/lib/boulevard.js`

- [ ] **Step 1: Confirm the two helpers are now dead**

Run: `grep -cE "\btrySyncAppointmentNotes\b" src/lib/boulevard.js` and `grep -cE "\btoBoulevardNaiveDateTime\b" src/lib/boulevard.js`
Expected: each returns `1` (definition only, zero callers). Also re-confirm no external refs: `grep -rnE "trySyncAppointmentNotes|toBoulevardNaiveDateTime" src/ __tests__/ | grep -v "src/lib/boulevard.js"` returns nothing. If either still has a caller, STOP and do not delete it.

- [ ] **Step 2: Delete both helper functions**

Delete `function toBoulevardNaiveDateTime(value) { ... }` (def at `:2808`) and `async function trySyncAppointmentNotes(apiUrl, headers, appointmentId, notes) { ... }` (def at `:2861`) in their entirety, including any leading comment block that belongs solely to each and the trailing blank line. Touch nothing else.

- [ ] **Step 3: Run the full suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: all green. If any test referenced these helpers (none should, per Step 1), fix the breakage before proceeding.

- [ ] **Step 4: Commit**

```bash
git add src/lib/boulevard.js
git commit -m "refactor(sms): drop trySyncAppointmentNotes and toBoulevardNaiveDateTime, now unused after cancel-rebook removal"
```

---

## Task 4: Update the incident ledger

**Files:**
- Modify: `QA_ISSUES.md`

- [ ] **Step 1: Update the `outbound-sms #11` Status line**

Find the `### outbound-sms #11` entry. Its Status currently reads (from PR A): `FIXED IN CODE 2026-06-03 (PR A, duration-upgrade path). Add-on path tracked separately (PR B). Bump to VERIFIED FIXED after merge + production deploy.`

Change it to:
```markdown
**Status:** FIXED IN CODE 2026-06-03. Duration path PR A (#47, merged 59f2607). Add-on path PR B (this PR), removes tryApplyAddonViaCancelRebook so neither path can cancel a booking under any env or flag. Bump to VERIFIED FIXED after merge + production deploy.
```

Add one sentence to the **Fix** paragraph of the entry noting the add-on path is now also covered: "PR B removes the add-on cancel-rebook (`tryApplyAddonViaCancelRebook`) the same way, so both the duration and add-on apply paths now fail closed with no reachable cancel."

- [ ] **Step 2: Commit**

```bash
git add QA_ISSUES.md
git commit -m "docs(qa): record add-on path cancel-rebook removal (PR B) under outbound-sms #11"
```

---

## Task 5: Confirm suite green and open the PR

**Files:** none (verification + PR + planning docs)

- [ ] **Step 1: Commit the planning docs**

Stage ONLY this plan file (and `TODOS.md` if it carries a PR-B-relevant item). Do NOT stage the stale `2026-06-02-safe-addon-append.md`.
```bash
git add docs/superpowers/plans/2026-06-03-addon-remove-cancel-rebook-fallback.md
git commit -m "docs: PR B plan for add-on cancel-rebook removal"
```

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: ALL GREEN. The add-on append-safety test is now green; no expected-red remains (unlike the period between PR A branch-cut and merge). If anything is red, stop and investigate before opening the PR.

- [ ] **Step 3: Push and open the PR (merge commit, no squash, no co-author trailer, no em dashes)**

```bash
git push -u origin fix/addon-remove-cancel-rebook
gh pr create --base main --head fix/addon-remove-cancel-rebook --title "fix(sms): remove cancel-rebook fallback from the add-on path (outbound-sms #11, PR B)" --body "$(cat <<'EOF'
PR B of the series hardening the SMS upgrade/add-on apply flow against outbound-sms #11. Mirrors PR A (#47) on the add-on side.

What this does:
- Deletes tryApplyAddonViaCancelRebook and its single caller block in reverifyAndApplyUpgradeForProfile so an add-on apply can never reach cancelAppointment under any env or flag.
- On any failure of the safe in-place append (tryApplyAddonViaBookingFromAppointment) the flow fails closed (addon_booking_from_appointment_failed), which the webhook routes to a queued support incident plus the approved finalize-by-team reply, leaving the appointment untouched.
- Removes trySyncAppointmentNotes and toBoulevardNaiveDateTime, which become unused once the last cancel-rebook caller is gone.

Context:
- The fallback was already disabled in production by the NODE_ENV check at boulevard.js:28-30, so this removes latent code and makes the no-cancel guarantee unconditional. No production behavior change.

Tests:
- __tests__/boulevard-addon-append-safety.test.js (cherry-picked red test, now green): static-source guard plus a behavioral guard that runs with the fallback flag on in non-production and asserts no cancel.

Scope lock: add-on path only. Duration path was PR A. Removing the now-unused BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK env var and ENABLE_CANCEL_REBOOK_FALLBACK constant is PR C.

Merge note: land via merge commit, not squash.
EOF
)"
```

- [ ] **Step 4: Merge as a merge commit (not squash) after review and CI** — executed at land time, not now.

---

## What already exists (reuse, do not rebuild)

- **Safe in-place append** — `tryApplyAddonViaBookingFromAppointment` (`boulevard.js:2963-3168`). The add-on already applies via `bookingCreateFromAppointment` then `bookingAddServiceAddon` then `bookingComplete` without cancelling. PR B keeps it as the sole apply path.
- **Fail-closed routing** — `route.js:192` and `:200` already queue a support incident and send the approved finalize reply for any non-success result. Reused; no new code. Confirmed live-wired during PR A's /review.
- **Production guard** — `boulevard.js:28-30` already disables the fallback in production. PR B makes the guarantee unconditional, no production behavior change.
- **Red test** — `6f7a37b` already wrote the exact guard; cherry-pick rather than rewrite.

## NOT in scope (considered and deferred)

- **Removing `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` and the `ENABLE_CANCEL_REBOOK_FALLBACK` constant** — PR C. After PR B the constant is unreferenced; PR C removes it and the Vercel env var.
- **Duration path** — done in PR A (#47).
- **Post-update verification of the in-place append/mutation** — `TODOS.md` item, separate concern.

## Failure modes (surviving add-on path after PR B)

| Codepath | Realistic production failure | Test covers it | Error handling exists | User sees |
|---|---|---|---|---|
| `tryApplyAddonViaBookingFromAppointment` returns `applied:false` | Boulevard error/timeout on bookingCreateFromAppointment / addServiceAddon / complete | Yes (cherry-picked behavioral test) | Yes (`addon_booking_from_appointment_failed` to webhook routing) | Approved finalize-by-team SMS + queued support incident; appointment untouched |

No silent-failure gap is introduced. The append is transactional from the member's view: it only mutates on `bookingComplete`, so a mid-sequence failure leaves the original appointment intact.

## Worktree parallelization

Sequential implementation, no parallelization opportunity. All tasks touch `src/lib/boulevard.js` and one test/doc each. Run in order in one branch.

## Implementation Tasks

- [ ] **T1 (P1, human: ~20min / CC: ~5min)** — branch — cut `fix/addon-remove-cancel-rebook` from `origin/main`, cherry-pick `6f7a37b`, confirm RED
  - Surfaced by: branch strategy + red-test reuse
  - Verify: `npx vitest run __tests__/boulevard-addon-append-safety.test.js` fails
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — boulevard.js — delete `tryApplyAddonViaCancelRebook` + fallback block; red test green
  - Surfaced by: plan goal + Test review
  - Verify: append-safety test passes; grep shows zero add-on cancel-rebook symbols
- [ ] **T3 (P2, human: ~20min / CC: ~5min)** — boulevard.js — remove orphaned `trySyncAppointmentNotes` + `toBoulevardNaiveDateTime`
  - Surfaced by: dead-code analysis (sole callers were in the deleted function)
  - Verify: each helper at 1 reference before deletion; full suite green after
- [ ] **T4 (P2, human: ~10min / CC: ~3min)** — QA_ISSUES.md — update outbound-sms #11 to record the add-on fix
  - Surfaced by: PR A left the add-on path "tracked separately (PR B)"
  - Verify: entry reflects both paths fixed in code

## Self-review

**Spec coverage.** Branch strategy decided with exact commands and justification; Q1-Q3 answered with evidence; exact deletions given with before/after; fail-closed behavior confirmed reusing PR A's live-wired path; red-test green path explained with its flag-on non-production design; "no stale destructive-success test elsewhere" confirmed by grep; full-suite-green stated with no expected-red; constraints (merge not squash, no co-author trailers, no em dashes) in header and Task 5.

**Placeholder scan.** No TODO/TBD/"handle edge cases" placeholders. Helper-removal guarded by an explicit reference-count check before deletion.

**Type/name consistency.** Symbols consistent: `tryApplyAddonViaCancelRebook`, `tryApplyAddonViaBookingFromAppointment`, `reverifyAndApplyUpgradeForProfile`, `ENABLE_CANCEL_REBOOK_FALLBACK`, reasons `applied_addon_booking_from_appointment` / `addon_booking_from_appointment_failed` / `addon_mutation_failed`. The static test greps add-on-specific names that do not collide with retained symbols (`BookingAddServiceAddonForSms` in the safe append is retained and distinct from the deleted `BookingAddServiceAddonForCancelRebook`).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (bug-fix, not a product change) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 0 critical gaps; 1 judgment call (orphan cleanup) resolved into PR |
| Outside Voice | codex | Independent 2nd opinion | 1 | clean | no factual errors; cherry-pick proven conflict-free via git merge-tree |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI) |

- **CODEX:** verified all five checked claims against current main (59f2607): function span 3169-3549, fallback block 3659-3698, safe append never cancels, `trySyncAppointmentNotes` + `toBoulevardNaiveDateTime` become dead while `getPrimaryAppointmentService` stays live, static greps will not false-match, cherry-pick is a clean add. One non-blocking caveat: untracked files in the worktree (handled by Task 5 staging only the PR-B plan).
- **CROSS-MODEL:** no tension. Review and codex agree the deletion is safe and the branch strategy is sound.
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED. Plan ready to implement (build not started, per instruction). Cut `fix/addon-remove-cancel-rebook` from `origin/main` and cherry-pick `6f7a37b` first.
