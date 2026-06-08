# Duration-Upgrade Tier Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member already on the 50-minute (or 90-minute) membership tier must never be selected as a 30-to-50 duration upgrade candidate, even when their booked appointment block buckets to 30 minutes.

**Architecture:** In the candidate-selection eligibility function `evaluateUpgradeEligibilityFromAppointments`, the already-at-or-above-target exclusion currently keys only off the bucketed booked-block duration. Add the membership tier as a second signal and gate on the greater of the two, so a tier-vs-block disagreement can never downgrade a 50 or 90 minute member into a 30-to-50 candidate. When tier is unresolved, fall back to the block signal, preserving today's behavior.

**Tech Stack:** Node (CommonJS-style ESM module), Boulevard Admin GraphQL, Vitest.

---

## Root Cause (confirmed, not re-litigated)

`evaluateUpgradeEligibilityFromAppointments` (`src/lib/boulevard.js`) derives "current duration" from the booked appointment block (`minutesBetweenIso(current.startOn, current.endOn)` at `:2305`, bucketed to {30,50,90} by `bucketDurationMinutes` at `:2306`). The only already-at-target exclusion (`:2380`, `currentDurationMinutes >= 50`) keys off that bucketed block. Amy Ballard ("50-Minute Membership", tag "50-MIN MEMBER") booked a Lymphatic Facial whose block bucketed to 30, so she read as a 30-minute member, passed the `>= 50` guard, and was offered the 30-to-50 upgrade. Her membership tier never entered the decision.

---

## Resolved Questions (read-only, answered before any change)

### Q1. Is `profile.tier` reliably populated for membership holders here? Is the null fallback safe?

`profile.tier` is set in `buildProfile` (`src/lib/boulevard.js:3534-3536`, assigned `:3551`):

```js
const tier =
  (d.membershipTier && String(d.membershipTier).trim()) ||
  parseTierFromText(d.membershipName || d.membershipPlanName || null);
// ...
tier: tier || null,
```

`parseTierFromText` (`:421-425`):

```js
function parseTierFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\b(30|50|90)\s*[- ]?minute\b/i);
  return match ? match[1] : null;
}
```

For Amy's plan name `"50-Minute Membership"`, the regex matches `50-Minute` and returns the string `"50"`. `durationMinutesFromTier("50")` (`:1543-1549`) returns `50`. So at the point `evaluateUpgradeEligibilityFromAppointments` runs, the profile built by `lookupMember`/`getClientById` carries `tier: "50"` for a standard 50-minute member, and `profileTierDuration` is already computed from it at `:2307`.

`profile.tier` can be `null` for real people when: the client is not a member (no membership node), or the membership name does not contain `30|50|90 minute` (renamed, comped, promo, or "Unlimited"/"VIP" style plans). The fix uses the GREATER of (block bucket, tier duration), so a null tier contributes nothing and the block signal alone governs, which is exactly today's behavior. This fallback is safe and never re-introduces the bug for members whose tier IS resolved: a resolved `"50"` or `"90"` always forces exclusion regardless of the block.

### Q2. Does `durationMinutesFromTier` map the real production tier values?

The real value that reaches this code is the string `parseTierFromText` produces: `"30"`, `"50"`, or `"90"` (or a stringified `d.membershipTier`). `durationMinutesFromTier` (`:1543-1549`) keys off exactly those strings:

```js
function durationMinutesFromTier(tier) {
  const normalizedTier = String(tier || '').trim();
  if (normalizedTier === '30') return 30;
  if (normalizedTier === '50') return 50;
  if (normalizedTier === '90') return 90;
  return null;
}
```

It normalizes with `String(tier || '').trim()`, so both the string form (`"50"`) and a numeric `membershipTier` stringify correctly. The mapping matches the real representation; the fix does not silently no-op for the "50-Minute Membership" plan. (The end-to-end name->tier mapping is asserted indirectly: the regression test passes `tier: "50"`, the exact value `parseTierFromText("50-Minute Membership")` yields.)

**Two checks on how tier is actually produced (from independent review):**
- `d.membershipTier` is NOT populated by the production lookup. The source object built by `lookupMember`/`getClientById` (`:3432-3451`) sets `membershipName` only; `membershipTier` appears solely in a mock fixture (`:3746`), where it is already canonical `"50"`. So in production, tier always resolves via `parseTierFromText(membershipName)`, and the `(d.membershipTier && String(...))` branch is mock-only and already canonical. No unparsed `"50-Minute"` string can reach `durationMinutesFromTier` from a real member.
- **Residual:** `parseTierFromText` (`:421`) matches only the full word `minute` (`/\b(30|50|90)\s*[- ]?minute\b/i`) and is called only in `buildProfile` (so its blast radius is tier derivation alone). The two reported members have the plan name `"50-Minute Membership"` and parse to `"50"`, so they are fully fixed. But a member whose Boulevard plan name is abbreviated (`"50-Min ..."`) or otherwise does not contain `NN-minute` resolves to `tier: null`, and the `max(...)` fix falls back to the block signal, leaving the bug in place for that member. This fix closes the reported cases and every member whose plan name contains `NN-minute`; it does not, by itself, close members with unparseable plan names. See "Pre-merge verification" and "Residual / follow-up" below.

### Q3. Does this exclusion belong in eligibility, and does anything downstream rely on these members being eligible?

Yes, it belongs in eligibility:
- The outbound scan gates the send on `opportunity.eligible` (`src/app/api/sms/automation/pre-appointment/route.js:773` / `:781`), so excluding here filters before any send.
- The apply/verify path (`reverifyAndApplyUpgradeForProfile`, PR #50) calls the same eligibility via `evaluateUpgradeOpportunityForProfile`, so the exclusion also prevents a stray 50-minute member from applying. That is defense in depth; this change does not touch the apply/verify logic itself.

No downstream code relies on a 50/90-minute member being a 30-to-50 candidate. The add-on path is unaffected:
- A genuine 50-minute member whose block buckets to 50 returns `no_upgrade_target_for_duration` at `:2352` (target is null for current >= 50) BEFORE reaching the modified `:2380` guard, so the add-on fallback path is reached exactly as today.
- The modified `:2380` return is the existing bare object `{ eligible: false, reason: 'already_at_or_above_target_duration' }` with no `appointmentId`/`startOn`. The route's `isAddonFallbackReason` (`route.js:139-148`) requires `opportunity.appointmentId && opportunity.startOn`, so an Amy-case exclusion does NOT trigger an add-on offer. The member is cleanly skipped, which is the intended in-scope behavior.

**Why the guard stays late (not before `pickUpgradeTargetDuration`):** placing the tier check earlier and bumping `currentDurationMinutes` up to the tier would make a 50-tier member with a 30-block return `no_upgrade_target_for_duration`, which the add-on fallback can pick up. That would be wrong: the Amy case is a 50-minute member whose CURRENT booking block is 30 minutes, and `buildAddonOffer` (`route.js:160`) requires `currentDuration === 50`, so an add-on cannot and should not be built for a 30-minute block. Keeping the exclusion at the existing late guard (`:2380`) skips her cleanly with no add-on, which is correct. A genuine 50-minute member booked into a real 50-minute block is a separate, unaffected path: their block buckets to 50, `pickUpgradeTargetDuration(50)` is null, and they return `no_upgrade_target_for_duration` at `:2352` BEFORE the guard, so they remain an add-on candidate exactly as today.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `__tests__/boulevard.test.js` | Modify | Regression tests in the existing `upgrade eligibility engine` describe block: tier 50 and tier 90 members with a 30-block are excluded; tier 30 and null-tier members with the same block stay eligible. |
| `src/lib/boulevard.js` | Modify | In `evaluateUpgradeEligibilityFromAppointments` at `:2380`, gate the already-at-or-above-target exclusion on `max(blockBucket, tierDuration)`, reusing `profileTierDuration` from `:2307`. |

No new files, no new exports, no schema changes.

---

### Task 1: Add the tier-exclusion regression tests (RED)

**Files:**
- Modify: `__tests__/boulevard.test.js`

- [ ] **Step 1: Add four tests inside the `upgrade eligibility engine` describe block**

Add these tests immediately after the existing `'infers 30-minute service for guests when raw appointment length is 30 + transition'` test (after line 569). They share one appointment fixture (a 30-minute member block plus a later same-provider appointment that leaves a 40-minute gap) and vary only `profile.tier`, isolating tier as the single variable.

```js
  describe('already-at-or-above-target tier exclusion', () => {
    // A 30-minute booked block (buckets to 30) plus a later same-provider
    // appointment leaving a 40-minute gap. Identical to the eligible fixtures
    // above; only profile.tier changes between cases.
    const thirtyBlockAppointments = [
      {
        id: 'appt-1',
        clientId: 'client-1',
        providerId: 'prov-1',
        startOn: '2026-06-05T10:00:00.000Z',
        endOn: '2026-06-05T10:30:00.000Z',
        status: 'BOOKED',
      },
      {
        id: 'appt-2',
        clientId: 'other',
        providerId: 'prov-1',
        startOn: '2026-06-05T11:10:00.000Z',
        endOn: '2026-06-05T11:40:00.000Z',
        status: 'BOOKED',
      },
    ];
    const opts = { now: '2026-06-05T08:00:00.000Z', windowHours: 6 };

    it('excludes a 50-minute-tier member whose booked block buckets to 30 (Amy case)', () => {
      const result = evaluateUpgradeEligibilityFromAppointments(
        thirtyBlockAppointments,
        { clientId: 'client-1', tier: '50', accountStatus: 'active' },
        opts
      );
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('already_at_or_above_target_duration');
    });

    it('excludes a 90-minute-tier member whose booked block buckets to 30', () => {
      const result = evaluateUpgradeEligibilityFromAppointments(
        thirtyBlockAppointments,
        { clientId: 'client-1', tier: '90', accountStatus: 'active' },
        opts
      );
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('already_at_or_above_target_duration');
    });

    it('still offers a genuine 30-minute-tier member with a 30 block (no over-correction)', () => {
      const result = evaluateUpgradeEligibilityFromAppointments(
        thirtyBlockAppointments,
        { clientId: 'client-1', tier: '30', accountStatus: 'active' },
        opts
      );
      expect(result.eligible).toBe(true);
      expect(result.currentDurationMinutes).toBe(30);
      expect(result.targetDurationMinutes).toBe(50);
    });

    it('falls back to the block signal when tier is unresolved (null)', () => {
      const result = evaluateUpgradeEligibilityFromAppointments(
        thirtyBlockAppointments,
        { clientId: 'client-1', tier: null, accountStatus: 'active' },
        opts
      );
      expect(result.eligible).toBe(true);
      expect(result.currentDurationMinutes).toBe(30);
      expect(result.targetDurationMinutes).toBe(50);
    });
  });
```

- [ ] **Step 2: Run the new tests and verify the two exclusion cases FAIL**

Run:

```bash
npx vitest run __tests__/boulevard.test.js -t "already-at-or-above-target tier exclusion"
```

Expected before implementation: the two exclusion tests FAIL. Today, a tier `"50"`/`"90"` member with a 30-block returns `{ eligible: true, currentDurationMinutes: 30, targetDurationMinutes: 50 }` (the bug), so `result.eligible` is `true` and `result.reason` is undefined instead of `already_at_or_above_target_duration`. The two eligible cases (tier 30, tier null) PASS already, proving the fix will not over-correct them.

- [ ] **Step 3: Commit the failing tests**

```bash
git add __tests__/boulevard.test.js
git commit -m "test(sms): a 50 or 90 minute member with a short block is not a 30-to-50 candidate"
```

---

### Task 2: Add the tier-based exclusion

**Files:**
- Modify: `src/lib/boulevard.js`
- Test: `__tests__/boulevard.test.js`

- [ ] **Step 1: Gate the exclusion on the greater of block bucket and tier duration**

In `evaluateUpgradeEligibilityFromAppointments`, replace the existing exclusion (`src/lib/boulevard.js:2377-2382`):

```js
  if (Number(targetDurationMinutes) !== 50) {
    return { eligible: false, reason: 'unsupported_upgrade_target' };
  }
  if (currentDurationMinutes >= 50) {
    return { eligible: false, reason: 'already_at_or_above_target_duration' };
  }
```

with:

```js
  if (Number(targetDurationMinutes) !== 50) {
    return { eligible: false, reason: 'unsupported_upgrade_target' };
  }
  // Already-at-or-above-target exclusion. Gate on the GREATER of the booked-block
  // bucket and the member's membership tier so a 50 or 90 minute member whose
  // current booking block happens to bucket to 30 (tier and booked-block
  // disagree, e.g. a 50-minute member booked into a short or non-ladder service)
  // is never selected as a 30-to-50 candidate. profileTierDuration is derived
  // above from profile.tier. When tier is unresolved (null), this falls back to
  // the block bucket alone, preserving prior behavior.
  const effectiveCurrentDuration = isFiniteNumber(profileTierDuration)
    ? Math.max(currentDurationMinutes, profileTierDuration)
    : currentDurationMinutes;
  if (effectiveCurrentDuration >= targetDurationMinutes) {
    return { eligible: false, reason: 'already_at_or_above_target_duration' };
  }
```

Notes:
- `profileTierDuration` is the variable already computed at `:2307` (`durationMinutesFromTier(profile?.tier)`); reuse it, do not recompute.
- `isFiniteNumber` is already used in this function (`:2306`, `:2310`).
- `targetDurationMinutes` is guaranteed to be `50` here by the `:2377` check, so `>= targetDurationMinutes` is equivalent to the old `>= 50` for the block path and is clearer about intent.

- [ ] **Step 2: Run the new tests and verify they pass**

Run:

```bash
npx vitest run __tests__/boulevard.test.js -t "already-at-or-above-target tier exclusion"
```

Expected after implementation: all four PASS. Tier 50 and 90 are excluded with `already_at_or_above_target_duration`; tier 30 and null stay eligible.

- [ ] **Step 3: Run the full upgrade-eligibility describe to confirm no over-correction**

Run:

```bash
npx vitest run __tests__/boulevard.test.js -t "upgrade eligibility engine"
```

Expected: PASS. In particular the existing `'infers 30-minute service for guests when raw appointment length is 30 + transition'` test (`tier: null`, 45-minute block) must still be eligible, proving the null-tier fallback is intact.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/lib/boulevard.js
git commit -m "fix(sms): exclude 50 and 90 minute members from 30-to-50 upgrade targeting"
```

---

### Task 3: Full Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run the boulevard suite**

Run:

```bash
npx vitest run __tests__/boulevard.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the full suite**

Run:

```bash
npx vitest run
```

Expected: PASS, no previously green test regresses.

- [ ] **Step 3: Confirm the change is the only behavioral edit**

Run:

```bash
git diff main...HEAD --stat
rg -n "effectiveCurrentDuration|already_at_or_above_target_duration" src/lib/boulevard.js
```

Expected: only `src/lib/boulevard.js` and `__tests__/boulevard.test.js` changed; the new `effectiveCurrentDuration` gate is present at the single exclusion site.

---

### Task 4: Merge

- [ ] **Step 1: Open the PR and merge with a merge commit (not squash)**

Merge with a merge commit so the test-then-fix history is preserved. No co-author trailers. No em dashes in the title or body.

---

## Self-Review

**Spec coverage:**
- 50/90 member never a 30-to-50 candidate: Task 2 gates on `max(blockBucket, tierDuration) >= target`. Covered (tests for 50 and 90).
- Exclusion alongside the existing block-based one, reusing `already_at_or_above_target_duration`: Task 2 keeps the same reason string. Covered.
- Regression (i) Amy case excluded: Task 1 test 1. Covered.
- Regression (ii) genuine 30 still eligible: Task 1 test 3. Covered.
- Regression (iii) null tier falls back to block, behaves as today: Task 1 test 4, plus the existing `:537` test still green (Task 2 Step 3). Covered.
- Real tier value in the fixture: tests use `tier: '50'` / `'90'`, the exact strings `parseTierFromText` yields. Covered.
- Full suite green: Task 3 Step 2. Covered.

**Placeholder scan:** None. Concrete file paths, line ranges, full code, exact commands, expected outcomes.

**Type consistency:**
- `effectiveCurrentDuration` is a number; compared with `>=` against `targetDurationMinutes` (number, 50 here).
- Reuses existing `profileTierDuration` (number|null) and `isFiniteNumber`; no new helpers or exports.
- Reason string unchanged: `already_at_or_above_target_duration`.

**Scope lock:** Only the candidate-selection tier exclusion in `evaluateUpgradeEligibilityFromAppointments` plus its tests. No change to apply/verify (PR #50), the add-on path, notify/alerts, or PR C.

---

## Pre-merge verification (read-only, before deploy)

The fix's coverage depends on `parseTierFromText(membership.name)` resolving real plan names to `"30"/"50"/"90"`. Before merge, confirm the actual production plan-name strings so the residual below is sized, not assumed:

```bash
# In production logs or Boulevard, list the distinct membership.name values
# that real members carry. Confirm the 50 and 90 minute plans are named with the
# full word "Minute" (e.g. "50-Minute Membership"), which parseTierFromText matches.
```

Pass criteria: the live 50 and 90 minute plan names contain `NN-minute` (full word). If any active plan name is abbreviated (`"50-Min"`) or otherwise unparseable, harden `parseTierFromText` FIRST (see follow-up) so the fix is not a partial no-op for those members. The two reported members ("50-Minute Membership") already pass.

## Residual / follow-up (NOT in this PR)

- **Harden `parseTierFromText` to accept abbreviations** (`"50-Min"`, `"50 min"`, the `"50-MIN MEMBER"` tag shape) by extending the regex to `min(?:ute)?s?`. This closes members whose plan names are abbreviated. Deferred because it touches a shared helper and is a distinct concern (tier parsing) from the candidate-selection guard; it warrants its own PR plus the plan-name verification above. Until then, this PR fully fixes every member whose plan name contains `NN-minute`, including the reported cases.

## NOT in scope (considered and deferred)

- `parseTierFromText` abbreviation hardening (above) — separate concern, shared helper.
- Reading the booked service's true service-duration field (instead of the appointment block bucket) to fix the underlying block mis-read — larger change to `scanAppointments`/eligibility; the tier guard solves the reported defect without it.
- Apply/verify logic (PR #50), add-on offer construction, notify/alerts, PR C — untouched.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_resolved | Scope tight (1 source file + tests); resolved questions verified against real code |
| Outside Voice | `codex exec` | Independent 2nd opinion | 1 | issues_found | 3 findings: 2 verified as non-issues, 1 real residual folded in |

- **CODEX:** flagged (1) add-on fallback interaction, (2) unparsed `membershipTier` string, (3) `parseTierFromText` misses abbreviations. (1) is a misread (genuine 50-block members return `no_upgrade_target` before the guard; the late-guard placement is deliberate and correct, and codex's "move it earlier" suggestion was rejected because it would wrongly route a 30-block member to an add-on). (2) verified NOT a production path (`membershipTier` is mock-only, canonical). (3) is a real residual now documented with a pre-merge verification step and a deferred follow-up.
- **CROSS-MODEL:** agreement that the `max(blockBucket, tierDuration)` gate correctly excludes resolved 50/90 tiers without over-correcting tier 30 or null. Disagreement only on guard placement (resolved in favor of the late guard).
- **UNRESOLVED:** none. One known residual (unparseable plan names) is documented, not silently dropped.
- **VERDICT:** ENG CLEARED for the reported defect. The fix is minimal (one exclusion site, reusing `profileTierDuration`), TDD-covered for the 50/90/30/null tier cases, and the null-tier fallback is proven safe by the existing `:537` test staying green. Residual coverage (abbreviated plan names) is gated by the pre-merge plan-name check and a deferred `parseTierFromText` follow-up.
