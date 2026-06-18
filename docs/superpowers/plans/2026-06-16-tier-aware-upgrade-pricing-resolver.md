# Tier-Aware Duration-Upgrade Pricing Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat "$50 more" duration-upgrade price (wrong for members) with one shared, tier-aware resolver that quotes a 30-minute member's real upgrade delta from their actual Boulevard monthly rate, persists it at offer-send time, echoes the same figure at confirmation, and exposes it for the apply path to consume, so a grandfathered member is never charged more than the offer quoted and a non-30-minute member is never offered a bogus upgrade.

**Architecture:** A single pure resolver `resolveUpgradePrice(profile) -> { deltaDollars, totalDollars, isMember } | null` becomes the one source of truth. It is CALLED once, at offer-send time in the `sms-upgrade-scan` cron path; the result is persisted on `session.pendingUpgradeOffer` as `deltaDollars` / `totalDollars` / `isMember`. The confirmation reply and (in a later, separate PR) the booking apply path READ those persisted fields and never recompute. Active members are priced only when their tier is a CONFIRMED 30-minute tier, at `max(0, 139 - their monthly rate)`; any other member case (tier 50/90, unresolvable tier, unresolvable rate, delta <= 0) is skipped (fail closed, no offer, no guess). Non-members get a flat `$50 / $169` from a single named constant. All amounts are pre-tax; tax settles at in-store checkout.

**Tech Stack:** Next.js 14 App Router route handlers, plain ES module in `src/lib/`, Vitest. No new dependencies. No new Boulevard query (the monthly rate is already fetched into `profile.monthlyRate`).

---

## Context the implementer needs (verified 2026-06-16, read-only)

- **The monthly rate already exists on the profile.** `lookupMember` / `getClientById` in `src/lib/boulevard.js` build `profile` via `buildProfile()`, which sets `monthlyRate` from the Boulevard `memberships` query field `unitPrice` (cents -> dollars, `Math.round(unitPrice)/100`, boulevard.js:3588-3592). It is `null` when no membership / no finite price. No schema change is needed.
- **Tier signal.** `profile.tier` is `'30'`/`'50'`/`'90'` parsed from the membership name, or `null` when not resolvable.
- **Active-member signal.** `profile.hasMembership === true` (set when Boulevard returns a membership record) AND `profile.accountStatus` not matching `/inactive|cancel/i`. The cron route already derives membership this way (pre-appointment route.js:170-172).
- **Where the flat $50 lives today.** `buildDurationOfferMessage` (pre-appointment route.js:195-206) reads `Number(pricing.walkinDelta || 50)`. `walkinDelta` is `WALKIN_PRICES['50'] - WALKIN_PRICES['30'] = 169 - 119 = 50` for everyone, members included. That is the bug: a `$99` member should be quoted `+$40`, a grandfathered `$79` member `+$60`.
- **Why the existing `computeUpgradePricing` is not enough.** Its member math uses a fixed `CURRENT_RATES['30'] = 99` base, so it cannot honor a grandfathered `$79`/`$129` member. The new resolver uses the member's ACTUAL `profile.monthlyRate`.
- **Persist point.** `session.pendingUpgradeOffer` is written at pre-appointment route.js:1098-1110 and already carries `isMember` and the full `pricing` object. We ADD `deltaDollars` and `totalDollars`; we keep `pricing` untouched for back-compat (addon confirmation + incident summary still read it).
- **Confirmation echo.** `buildDurationPricingText` (twilio webhook route.js:132-141 on `main`) currently emits `"30->50 is +$<walkinDelta> ($<walkinTotal> total; members get 20% off)."` We change it to read the persisted `deltaDollars` and emit honest, pre-tax copy with no false total / discount claim.
- **PR stack / base (locked, D2).** This PR branches off `main` and is reviewed ready-to-merge BEFORE PR #58 (`fix/webhook-defer-post-reply-after`), PR #59 (`fix/webhook-offscript-and-confirmation-price`, stacked on #58), and the apply-path rebuild. #59 ALSO rewrites `buildDurationPricingText` (to `"That extends your facial to <target> minutes for $<walkinDelta> more."`); this plan converges on the SAME sentence but sourced from `deltaDollars`, so after this lands #59 rebases and keeps only its off-script-routing changes, sourcing the confirmation price from this PR's persisted fields. Task 0 verifies #58 does not touch our exact edit sites; flag if it forces a different base.

---

## Decisions already made (by Matt; locked, do not re-litigate)

- **D-A: Member formula.** Active member with a CONFIRMED 30-minute tier: `deltaDollars = max(0, 139 - monthlyRate)`; `totalDollars = 139`. Examples: `$99 -> +$40`, `$79 -> +$60`.
- **D-B: Required 30-minute tier gate, fail closed.** Never price a non-30-minute member. An active member whose tier is 50/90-minute, OR whose tier cannot be resolved, OR whose `monthlyRate` cannot be resolved -> SKIP the candidate, log it, send no offer. Concrete reason: a grandfathered 50-minute member (real "Taylor" case, $129/mo) computes a positive sub-$139 delta and would otherwise be offered a bogus cheap "upgrade" to the tier they already hold.
- **D-C: Delta floor.** Floor `deltaDollars` at 0; if `<= 0`, skip the candidate and log it.
- **D-D: Non-member.** A single named constant `NONMEMBER_UPGRADE = { deltaDollars: 50, totalDollars: 169 }`. Matt may flip to `49 / 168` later; it must stay a one-line change. Non-member / walk-in / repeat non-member / cancelled member all use it. The member reference total stays `139` (`MEMBER_50_MIN_TOTAL`).
- **D-E: Pre-tax everywhere.** All amounts are pre-tax; tax settles at in-store checkout (per the apply-path D2 payment model: the booking adds the delta, tax handled in store). The offer and confirmation copy state the pre-tax delta and must NOT imply a tax-inclusive total.
- **D-F: One source of truth, three consumers.** OFFER quotes `deltaDollars` and persists `{deltaDollars, totalDollars, isMember}`; CONFIRMATION reads the persisted fields; APPLY (separate, parked PR) reads the persisted fields. Never recompute downstream; never trust catalog price.
- **D-G: Scope lock.** This PR = resolver module + offer cron + confirmation read + tests. The booking-mutation rebuild stays its own parked PR (it will read the persisted price). The cancellation chat widget's own `$50` fallback is OUT of scope (surfaced below).
- **D-H: Merge order.** This resolver PR is reviewed ready-to-merge BEFORE #58, #59, and the apply-path PR. Nothing auto-merges; Matt approves the order. The apply-path PR stays parked until this is approved, since it reads these fields.

## Still-open (not blocking the build; confirm before the apply path merges)

- **`168` vs `169` non-member total** (and whether the non-member delta becomes `49` if so). Built now as `50 / 169` in the single `NONMEMBER_UPGRADE` constant; one-line change later.

---

## File Structure

- **Create:** `src/lib/upgrade-pricing.js` — the resolver + the pricing constants. Pure, no I/O, no runtime import of the heavy `boulevard.js`. One responsibility: turn a `profile` into a sendable price or a skip signal.
- **Create:** `__tests__/upgrade-pricing.test.js` — unit tests for every resolver branch + a drift guard against `CURRENT_RATES['50']`.
- **Modify:** `src/app/api/sms/automation/pre-appointment/route.js` — import + call the resolver for duration offers (skip on `null`), attach `deltaDollars`/`totalDollars`/`isMember` to the offer, persist them, and switch `buildDurationOfferMessage` off the `|| 50` hardcode onto `deltaDollars`.
- **Modify:** `src/app/api/sms/twilio/webhook/route.js` — `buildDurationPricingText` reads the persisted `deltaDollars`, emits honest pre-tax copy.
- **Modify:** `__tests__/sms-automation-route.test.js` — new offer tests (member `$40`, non-member `$50`, skip-on-unresolved) + update existing member duration-offer fixtures to include `monthlyRate` (else they now skip).
- **Modify:** `__tests__/twilio-webhook-route.test.js` — new confirmation echo + parity tests + update any existing fixture that asserts a priced confirmation to include `deltaDollars`.

---

## Task 0: Branch + preflight

**Files:** none (setup; this PR is its own branch off `main`, merged before #58/#59 and the apply-path rebuild).

- [ ] **Step 1: Branch off `main`.** A push hook permits non-force pushes to `fix/*` only.

```bash
cd ~/sm-member-cancel
git fetch origin
git checkout -b fix/sms-tier-aware-upgrade-pricing origin/main
```

- [ ] **Step 2: Confirm the monthly rate + tier are on the profile (sanity, no code change).**

Run: `grep -n "monthlyRate\|tier:" src/lib/boulevard.js | head`
Expected: lines deriving `monthlyRate` from `unitPrice` (boulevard.js:3588 area) and a `tier` field on the profile.

- [ ] **Step 3: Confirm the current flat-$50 site.** Run: `grep -n "walkinDelta || 50" src/app/api/sms/automation/pre-appointment/route.js`
Expected: one hit at line ~200 inside `buildDurationOfferMessage`.

- [ ] **Step 4: Verify base independence from #58 (D2 flag).** Confirm PR #58 does not rewrite the exact functions this PR edits.

Run: `git diff origin/main...origin/fix/webhook-defer-post-reply-after -- src/app/api/sms/twilio/webhook/route.js src/app/api/sms/automation/pre-appointment/route.js | grep -n "buildDurationPricingText\|buildDurationOfferMessage\|pendingUpgradeOffer =" || echo "no overlap with our edit sites"`
Expected: `no overlap with our edit sites`. If #58 DOES touch `buildDurationPricingText`, `buildDurationOfferMessage`, or the `pendingUpgradeOffer = {` block, STOP and flag Matt: the base may need to be #58 instead of `main`.

## Task 1: The resolver module (pure, fully unit-tested)

**Files:**
- Create: `__tests__/upgrade-pricing.test.js`
- Create: `src/lib/upgrade-pricing.js`

- [ ] **Step 1: Write the failing tests.**

```javascript
// __tests__/upgrade-pricing.test.js
import { describe, it, expect, vi } from 'vitest';
import { resolveUpgradePrice, MEMBER_50_MIN_TOTAL } from '../src/lib/upgrade-pricing.js';
import { CURRENT_RATES } from '../src/lib/boulevard.js';

describe('resolveUpgradePrice', () => {
  // Active member with a confirmed 30-minute tier.
  const member30 = (monthlyRate) => ({
    clientId: 'client-1', hasMembership: true, accountStatus: 'ACTIVE', tier: '30', monthlyRate,
  });

  it('prices a $99 30-min member at +$40, total $139', () => {
    expect(resolveUpgradePrice(member30(99))).toEqual({ deltaDollars: 40, totalDollars: 139, isMember: true });
  });

  it('prices a grandfathered $79 30-min member at +$60', () => {
    expect(resolveUpgradePrice(member30(79))).toEqual({ deltaDollars: 60, totalDollars: 139, isMember: true });
  });

  it('SKIPS a $129 50-min member (the Taylor case; must never price a non-30-min member)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const taylor = { clientId: 'taylor', hasMembership: true, accountStatus: 'ACTIVE', tier: '50', monthlyRate: 129 };
    expect(resolveUpgradePrice(taylor)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('SKIPS an active member whose tier cannot be resolved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noTier = { clientId: 'c', hasMembership: true, accountStatus: 'ACTIVE', tier: null, monthlyRate: 99 };
    expect(resolveUpgradePrice(noTier)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('FAILS CLOSED (returns null) when a 30-min member rate is unresolvable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUpgradePrice(member30(null))).toBeNull();
    expect(resolveUpgradePrice(member30(undefined))).toBeNull();
    expect(resolveUpgradePrice(member30(0))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips (returns null) when the 30-min member delta is <= 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUpgradePrice(member30(139))).toBeNull(); // delta 0
    expect(resolveUpgradePrice(member30(150))).toBeNull(); // floored to 0
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prices a non-member at a flat +$50, total $169', () => {
    const nonMember = { clientId: 'c2', hasMembership: false, accountStatus: null, tier: null };
    expect(resolveUpgradePrice(nonMember)).toEqual({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  it('ignores any stray rate on a non-member (flat $50/$169)', () => {
    const repeatNonMember = { clientId: 'c3', hasMembership: false, tier: null, monthlyRate: 119 };
    expect(resolveUpgradePrice(repeatNonMember)).toEqual({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  it('treats a cancelled member as a non-member (flat $50/$169)', () => {
    const cancelled = { clientId: 'c4', hasMembership: true, accountStatus: 'CANCELLED', tier: '30', monthlyRate: 99 };
    expect(resolveUpgradePrice(cancelled)).toEqual({ deltaDollars: 50, totalDollars: 169, isMember: false });
  });

  it('keeps the member total in sync with the canonical rate table (drift guard)', () => {
    expect(MEMBER_50_MIN_TOTAL).toBe(CURRENT_RATES['50']);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run __tests__/upgrade-pricing.test.js`
Expected: FAIL — `resolveUpgradePrice is not a function` / module not found.

- [ ] **Step 3: Implement the resolver.**

```javascript
// src/lib/upgrade-pricing.js
//
// Tier-aware duration-upgrade pricing. Single source of truth for the 30->50
// upgrade price quoted in the outbound offer, echoed at confirmation, and
// (in a later PR) written to the Boulevard booking line at apply time.
// All amounts are PRE-TAX US dollars; tax settles at in-store checkout.

// Member 50-minute total. Mirrors CURRENT_RATES['50'] in boulevard.js (the
// canonical member rate table); the drift-guard test keeps them equal.
const MEMBER_50_MIN_TOTAL = 139;

// Non-member 30->50 upgrade. SINGLE named constant so the open "168 vs 169"
// question (and a matching 49 delta) is a one-line change here and nowhere else.
const NONMEMBER_UPGRADE = { deltaDollars: 50, totalDollars: 169 };

// Returns { deltaDollars, totalDollars, isMember } for a sendable offer, or null
// to signal "skip this candidate" (logged). Never guesses, never prices a
// non-30-minute member.
function resolveUpgradePrice(profile) {
  const tier = String(profile?.tier || '').trim();
  const status = String(profile?.accountStatus || '').toLowerCase();
  const inactive = /inactive|cancel/i.test(status);
  const believedMember = (profile?.hasMembership === true || Boolean(tier)) && !inactive;

  // Non-member / walk-in / repeat non-member / cancelled member -> flat price.
  if (!believedMember) {
    return { deltaDollars: NONMEMBER_UPGRADE.deltaDollars, totalDollars: NONMEMBER_UPGRADE.totalDollars, isMember: false };
  }

  // Active member: REQUIRE a confirmed 30-minute tier. Never price a 50/90-min
  // member: a grandfathered $129/mo 50-min member computes a positive sub-$139
  // delta and would otherwise be offered a bogus "upgrade" to the tier they hold.
  if (tier !== '30') {
    console.warn('[upgrade-pricing] skip: member tier not confirmed 30-min', { clientId: profile?.clientId || null, tier: tier || null });
    return null;
  }

  const monthlyRate = Number(profile?.monthlyRate);
  if (!Number.isFinite(monthlyRate) || monthlyRate <= 0) {
    // Fail closed: we believe they are a 30-min member but cannot read their
    // rate, so we cannot honor "never charge more than quoted." Skip, never guess.
    console.warn('[upgrade-pricing] skip: member monthly rate unresolved', { clientId: profile?.clientId || null });
    return null;
  }

  const deltaDollars = Math.max(0, MEMBER_50_MIN_TOTAL - monthlyRate);
  if (deltaDollars <= 0) {
    console.warn('[upgrade-pricing] skip: non-positive member upgrade delta', { clientId: profile?.clientId || null, monthlyRate });
    return null;
  }

  return { deltaDollars, totalDollars: MEMBER_50_MIN_TOTAL, isMember: true };
}

export { resolveUpgradePrice, MEMBER_50_MIN_TOTAL, NONMEMBER_UPGRADE };
```

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run __tests__/upgrade-pricing.test.js`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/upgrade-pricing.js __tests__/upgrade-pricing.test.js
git commit -m "feat(pricing): tier-aware upgrade price resolver (single source of truth)"
```

## Task 2: Wire the OFFER (sms-upgrade-scan cron path)

**Files:**
- Modify: `src/app/api/sms/automation/pre-appointment/route.js`
- Modify: `__tests__/sms-automation-route.test.js`

- [ ] **Step 1: Write the failing offer tests.** Append to `__tests__/sms-automation-route.test.js`, inside `describe('sms automation route', ...)`. They mirror the existing "allows outbound processing" test (line 408) but assert the rendered delta and the persisted fields. `mockSaveSession` is set in `beforeEach` to return the session, so the persisted offer is the arg of its last call.

```javascript
it('quotes the member tier-aware delta in the offer and persists it', async () => {
  mockLookupMember.mockResolvedValue({
    clientId: 'client-1', phone: '+19175551234', tier: '30',
    hasMembership: true, accountStatus: 'ACTIVE', monthlyRate: 99,
    firstName: 'Debbie', name: 'Debbie Von Ahrens', email: 'debbie@example.com',
  });
  mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
    eligible: true, appointmentId: 'appt-1', targetDurationMinutes: 50, currentDurationMinutes: 30,
    isMember: true, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
    startOn: '2026-03-09T18:00:00Z',
  });
  mockSendTwilioSms.mockResolvedValue({ sid: 'SM123' });

  const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
    body: JSON.stringify({
      dryRun: false, liveApproval: true, now: '2026-03-09T15:00:00Z',
      sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
      candidates: [{ firstName: 'Debbie', lastName: 'Von Ahrens', email: 'debbie@example.com', phone: '+1 (917) 555-1234' }],
    }),
  });
  const res = await POST(req);
  const body = await res.json();

  expect(res.status).toBe(200);
  expect(body.results[0].status).toBe('sent');
  expect(mockSendTwilioSms.mock.calls[0][0].body).toContain('for just $40 more');
  const persisted = mockSaveSession.mock.calls.at(-1)[0].pendingUpgradeOffer;
  expect(persisted.deltaDollars).toBe(40);
  expect(persisted.totalDollars).toBe(139);
  expect(persisted.isMember).toBe(true);
});

it('quotes the flat non-member delta in the offer', async () => {
  mockLookupMember.mockResolvedValue({
    clientId: 'client-2', phone: '+19175551235', tier: null, hasMembership: false, accountStatus: null,
    firstName: 'Sam', name: 'Sam Doe', email: 'sam@example.com',
  });
  mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
    eligible: true, appointmentId: 'appt-2', targetDurationMinutes: 50, currentDurationMinutes: 30,
    isMember: false, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
    startOn: '2026-03-09T18:00:00Z',
  });
  mockSendTwilioSms.mockResolvedValue({ sid: 'SM124' });

  const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
    body: JSON.stringify({
      dryRun: false, liveApproval: true, now: '2026-03-09T15:00:00Z',
      sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
      candidates: [{ firstName: 'Sam', lastName: 'Doe', email: 'sam@example.com', phone: '+1 (917) 555-1235' }],
    }),
  });
  const res = await POST(req);
  const body = await res.json();

  expect(body.results[0].status).toBe('sent');
  expect(mockSendTwilioSms.mock.calls[0][0].body).toContain('for just $50 more');
  expect(mockSaveSession.mock.calls.at(-1)[0].pendingUpgradeOffer.deltaDollars).toBe(50);
});

it('skips the duration offer when a 30-min member rate is unresolvable', async () => {
  mockLookupMember.mockResolvedValue({
    clientId: 'client-3', phone: '+19175551236', tier: '30',
    hasMembership: true, accountStatus: 'ACTIVE', monthlyRate: null,
    firstName: 'Pat', name: 'Pat Roe', email: 'pat@example.com',
  });
  mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
    eligible: true, appointmentId: 'appt-3', targetDurationMinutes: 50, currentDurationMinutes: 30,
    isMember: true, pricing: { memberTotal: 139, memberDelta: 40, walkinTotal: 169, walkinDelta: 50 },
    startOn: '2026-03-09T18:00:00Z',
  });

  const req = new Request('http://localhost/api/sms/automation/pre-appointment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-automation-token': 'token' },
    body: JSON.stringify({
      dryRun: false, liveApproval: true, now: '2026-03-09T15:00:00Z',
      sendTimezone: 'America/New_York', sendStartHour: 9, sendEndHour: 17,
      candidates: [{ firstName: 'Pat', lastName: 'Roe', email: 'pat@example.com', phone: '+1 (917) 555-1236' }],
    }),
  });
  const res = await POST(req);
  const body = await res.json();

  expect(body.results[0].status).toBe('skipped');
  expect(body.results[0].reason).toBe('duration_price_unresolved');
  expect(mockSendTwilioSms).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run __tests__/sms-automation-route.test.js -t "tier-aware delta"`
Expected: FAIL — body still contains `$50 more` (hardcode) and `persisted.deltaDollars` is `undefined`.

- [ ] **Step 3: Import the resolver.** At the top of `src/app/api/sms/automation/pre-appointment/route.js`, add to the existing imports (match the relative depth of the other `src/lib`-style imports already in this file; adjust the `../` count to resolve to `src/lib/upgrade-pricing.js`):

```javascript
import { resolveUpgradePrice } from '../../../../../lib/upgrade-pricing.js';
```

- [ ] **Step 4: Resolve + attach + skip, immediately before the offer message is built.** Find the line `const offerMessage = buildOutboundOfferMessage(selectedOffer, {` (route.js:1019). Insert this block directly ABOVE it:

```javascript
      // Tier-aware pricing for duration offers: quote the member's real upgrade
      // delta (grandfathered rates included), never a flat $50, and never a
      // non-30-minute member. Fail closed (skip) per resolveUpgradePrice.
      if (selectedOffer.offerKind === 'duration') {
        const upgradePrice = resolveUpgradePrice(profile);
        if (!upgradePrice) {
          results.push({
            candidate: { firstName, lastName, email: email || null, phone: phone || null },
            profile: { clientId: profile.clientId || null, phone: profilePhone, tier: profile.tier || null },
            status: 'skipped',
            reason: 'duration_price_unresolved',
            sessionId: session.id,
            appointmentId,
            matchedContact,
            source: work.source,
            queueId: work.queueId,
          });
          continue;
        }
        selectedOffer.deltaDollars = upgradePrice.deltaDollars;
        selectedOffer.totalDollars = upgradePrice.totalDollars;
        selectedOffer.isMember = upgradePrice.isMember;
      }

```

- [ ] **Step 5: Switch `buildDurationOfferMessage` off the hardcode onto `deltaDollars`.** Replace the whole function (route.js:195-206) with (the copy states a pre-tax delta, no total):

```javascript
function buildDurationOfferMessage(opportunity, options = {}) {
  const reminder = options.reminder === true;
  const firstName = asText(options.firstName);
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  if (reminder) {
    return `${greeting} just a reminder - the upgrade to 50 minutes is still available for your appointment today. Reply YES or NO.`;
  }
  const delta = Number(opportunity?.deltaDollars);
  if (!Number.isFinite(delta) || delta <= 0) return null;
  return `${greeting} good news - there's room to extend your facial today to 50 minutes for just $${delta} more. Reply YES to upgrade or NO to keep your current booking.`;
}
```

- [ ] **Step 6: Persist `deltaDollars` / `totalDollars`.** In the `session.pendingUpgradeOffer = { ... }` object (route.js:1098-1110), add these two fields right after the `isMember:` line (keep `pricing:` as-is):

```javascript
          deltaDollars: Number.isFinite(Number(selectedOffer.deltaDollars)) ? Number(selectedOffer.deltaDollars) : null,
          totalDollars: Number.isFinite(Number(selectedOffer.totalDollars)) ? Number(selectedOffer.totalDollars) : null,
```

- [ ] **Step 7: Update existing member duration-offer fixtures.** The fail-closed resolver now SKIPS any member duration-offer test whose fixture lacks a confirmed 30-min tier + `monthlyRate`. Fix the known one and any others the suite surfaces. In `__tests__/sms-automation-route.test.js`, the "allows outbound processing when klaviyo consent is valid" test (line ~409) `mockLookupMember.mockResolvedValue({...})` must gain `hasMembership: true, accountStatus: 'ACTIVE', monthlyRate: 99` (it already has `tier: '30'`):

```javascript
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+19175551234',
      tier: '30',
      hasMembership: true,
      accountStatus: 'ACTIVE',
      monthlyRate: 99,
      firstName: 'Debbie',
      name: 'Debbie Von Ahrens',
      email: 'debbie@example.com',
    });
```

- [ ] **Step 8: Run the new tests, then the whole offer suite.**

Run: `npx vitest run __tests__/sms-automation-route.test.js -t "tier-aware delta"` then `npx vitest run __tests__/sms-automation-route.test.js`
Expected: the three new tests PASS; the full file PASSES. If any other test now reports `status: 'skipped'` with `reason: 'duration_price_unresolved'`, that fixture is a member duration offer missing a confirmed `tier: '30'` and/or `monthlyRate` — add `hasMembership: true, accountStatus: 'ACTIVE', tier: '30', monthlyRate: <value>` to its `mockLookupMember`/`mockGetClientById` and re-run. Do NOT relax the resolver to make a test pass.

- [ ] **Step 9: Commit.**

```bash
git add src/app/api/sms/automation/pre-appointment/route.js __tests__/sms-automation-route.test.js
git commit -m "feat(offer): quote tier-aware upgrade delta and persist it at send time"
```

## Task 3: Wire the CONFIRMATION (twilio webhook)

**Files:**
- Modify: `src/app/api/sms/twilio/webhook/route.js`
- Modify: `__tests__/twilio-webhook-route.test.js`

- [ ] **Step 1: Write the failing confirmation tests.** Append inside `describe('twilio webhook route', ...)`. The confirmation pricing sentence appears on the non-instant (manual) path, so mock the apply to `success: false` and put the persisted offer on the session. Mirrors the existing YES test (line 220) but adds `pendingUpgradeOffer` and asserts the echoed delta + no tax-inclusive/"20% off" claim.

```javascript
it('echoes the persisted member delta at confirmation (pre-tax, no total claim)', async () => {
  const session = {
    id: 'sess-1', status: 'active', smsInboundCount: 0,
    pendingUpgradeOffer: {
      offerKind: 'duration', appointmentId: 'appt-1', targetDurationMinutes: 50,
      currentDurationMinutes: 30, isMember: true, deltaDollars: 40, totalDollars: 139,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
  };
  mockGetSessionIdForPhone.mockReturnValue('sess-1');
  mockGetSession.mockReturnValue(session);
  mockLookupMember.mockResolvedValue({ clientId: 'client-1', phone: '+12134401333', tier: '30', accountStatus: 'ACTIVE' });
  mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
    eligible: true, appointmentId: 'appt-1', currentDurationMinutes: 30, targetDurationMinutes: 50, isMember: true,
  });
  mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_disabled' });

  const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
    method: 'POST', headers: { 'x-twilio-signature': 'sig' },
    body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-conf-1',
  });
  const res = await POST(req);
  const text = await res.text();

  expect(res.status).toBe(200);
  expect(text).toContain('for $40 more');
  expect(text).not.toContain('20% off');
  expect(text).not.toContain('total');
  expect(text).not.toContain('%'); // zero percentage language anywhere in the duration confirmation
});

it('echoes the persisted non-member delta at confirmation', async () => {
  const session = {
    id: 'sess-2', status: 'active', smsInboundCount: 0,
    pendingUpgradeOffer: {
      offerKind: 'duration', appointmentId: 'appt-2', targetDurationMinutes: 50,
      currentDurationMinutes: 30, isMember: false, deltaDollars: 50, totalDollars: 169,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
  };
  mockGetSessionIdForPhone.mockReturnValue('sess-2');
  mockGetSession.mockReturnValue(session);
  mockLookupMember.mockResolvedValue({ clientId: 'client-2', phone: '+12134401334', tier: null, accountStatus: null });
  mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
    eligible: true, appointmentId: 'appt-2', currentDurationMinutes: 30, targetDurationMinutes: 50, isMember: false,
  });
  mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_disabled' });

  const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
    method: 'POST', headers: { 'x-twilio-signature': 'sig' },
    body: 'From=%2B12134401334&Body=Yes&MessageSid=SM-in-conf-2',
  });
  const res = await POST(req);
  const text = await res.text();

  expect(text).toContain('for $50 more');
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run __tests__/twilio-webhook-route.test.js -t "persisted member delta at confirmation"`
Expected: FAIL — on `main`, `buildDurationPricingText` reads `pricing.walkinDelta` (undefined here) and/or emits the old "20% off" + "total" copy, so `for $40 more` is absent.

- [ ] **Step 3: Implement.** Replace `buildDurationPricingText` (twilio webhook route.js:132-141) with (pre-tax delta, no total, no discount claim):

```javascript
function buildDurationPricingText(opportunity) {
  const target = Number(opportunity?.targetDurationMinutes || 0) || null;
  // Echo the exact pre-tax delta the offer quoted. The offer keys off the
  // persisted deltaDollars (tier-aware), so the confirmation reads the same
  // field and can never contradict the offer. No total and no "20% off" claim:
  // the duration offer quoted neither, and tax settles at in-store checkout.
  const delta = Number(opportunity?.deltaDollars);
  if (!target || !Number.isFinite(delta) || delta <= 0) return '';
  return `That extends your facial to ${target} minutes for $${delta} more.`;
}
```

- [ ] **Step 4: Run the new tests, then the whole webhook suite.**

Run: `npx vitest run __tests__/twilio-webhook-route.test.js`
Expected: the two new tests PASS; the full file PASSES. If a pre-existing test asserted the old priced confirmation text (a `+$50`, `total`, or `20% off` substring, or a manual-path test relying on `pricing.walkinDelta`), update that test's `pendingUpgradeOffer` fixture to carry `deltaDollars` and drop the stale assertion. Tests asserting the generic fallback (`We received your upgrade request`) or success copy (`You're all set`) are unaffected.

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/sms/twilio/webhook/route.js __tests__/twilio-webhook-route.test.js
git commit -m "fix(confirmation): echo the persisted tier-aware pre-tax delta, drop the false 20%-off claim"
```

## Task 4: Cross-consumer parity (offer delta == confirmation delta)

**Files:**
- Modify: `__tests__/twilio-webhook-route.test.js` (a focused parity block; the offer side is already locked by Task 2)

- [ ] **Step 1: Write the parity test.** Proves the SAME persisted `deltaDollars` the offer renders is the one the confirmation renders, for one member and one non-member. Uses the persisted-offer shape Task 2 Step 6 writes, so offer and confirmation cannot drift.

```javascript
describe('offer/confirmation delta parity', () => {
  const cases = [
    { label: 'member $99', deltaDollars: 40, totalDollars: 139, isMember: true, phone: '+12134401350' },
    { label: 'non-member', deltaDollars: 50, totalDollars: 169, isMember: false, phone: '+12134401351' },
  ];
  for (const c of cases) {
    it(`confirmation renders the same delta the offer persisted (${c.label})`, async () => {
      const session = {
        id: `sess-${c.label}`, status: 'active', smsInboundCount: 0,
        pendingUpgradeOffer: {
          offerKind: 'duration', appointmentId: 'appt-x', targetDurationMinutes: 50, currentDurationMinutes: 30,
          isMember: c.isMember, deltaDollars: c.deltaDollars, totalDollars: c.totalDollars,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        },
      };
      mockGetSessionIdForPhone.mockReturnValue(session.id);
      mockGetSession.mockReturnValue(session);
      mockLookupMember.mockResolvedValue({ clientId: 'c', phone: c.phone, tier: c.isMember ? '30' : null, accountStatus: c.isMember ? 'ACTIVE' : null });
      mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({ eligible: true, appointmentId: 'appt-x', currentDurationMinutes: 30, targetDurationMinutes: 50, isMember: c.isMember });
      mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: false, reason: 'upgrade_mutation_disabled' });

      const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
        method: 'POST', headers: { 'x-twilio-signature': 'sig' },
        body: `From=${encodeURIComponent(c.phone)}&Body=Yes&MessageSid=SM-${c.label.replace(/\W/g, '')}`,
      });
      const text = await (await POST(req)).text();
      expect(text).toContain(`for $${c.deltaDollars} more`);
    });
  }
});
```

- [ ] **Step 2: Run.** Run: `npx vitest run __tests__/twilio-webhook-route.test.js -t "delta parity"`
Expected: PASS for both cases.

- [ ] **Step 3: Run the FULL suite (no regressions across the repo).** Run: `npx vitest run`
Expected: all green. Investigate and fix any failure as a fixture/contract gap per Tasks 2 and 3; never weaken the resolver to pass a test.

- [ ] **Step 4: Commit.**

```bash
git add __tests__/twilio-webhook-route.test.js
git commit -m "test(pricing): lock offer/confirmation delta parity for member and non-member"
```

---

## Apply-path contract (Consumer 3 — NOT built here)

The booking-mutation rebuild (separate, parked PR, `docs/superpowers/plans/2026-06-15-sms-duration-upgrade-apply-rebuild.md`, Decision D2) will set the Boulevard booking line price from the persisted offer, reading:

- `pendingUpgradeOffer.deltaDollars` — the quoted pre-tax upgrade delta.
- `pendingUpgradeOffer.totalDollars` — the 50-minute pre-tax line total.

It must NOT recompute and must NOT trust catalog price; tax settles at in-store checkout. This plan guarantees those fields exist and equal what the member was quoted. (No code change to the apply path or its plan in THIS PR.)

## Gauntlet + ship gates (run at build time, after the four tasks)

- Subagent spec review of the diff, `/codex` on the diff, `/review` specialists, and `/cso` (the change touches member-facing price copy and a charge-relevant persisted field).
- This is its own PR off `main`, reviewed ready-to-merge BEFORE #58, #59, and the apply-path rebuild. Keep all of them open until Matt approves the merge order. Nothing auto-merges.
- STOP for Matt's approval before any merge.

## Out of scope (surfaced, not built here)

- **Cancellation chat widget duration offer.** `src/app/api/chat/message/route.js:252` and `:259` carry the same `walkinDelta || 50` flat fallback. Different workload (the web chatbot, not outbound SMS), not one of the three named consumers. Recommend a follow-up PR to point it at `resolveUpgradePrice`. Left untouched to honor one-fix-per-PR scope-lock.
- **The `168` vs `169` non-member total** (and a matching `49` delta) — confirm before the apply path merges; one-line change to `NONMEMBER_UPGRADE`.
- **PR #58 / #59 reconciliation** — Matt owns merge order; #59's `buildDurationPricingText` edit is superseded by this PR's after rebase.
- **Existing `computeUpgradePricing` / the `pricing` object** — left in place (back-compat for addon copy and the incident summary). Not refactored.

## Self-review

- **Spec coverage:** resolver signature + member formula (Task 1, D-A); REQUIRED 30-min tier gate, fail closed, incl. the $129 50-min Taylor SKIP and unresolvable-tier SKIP (Task 1, D-B); unresolvable rate SKIP (Task 1); delta<=0 skip (Task 1, D-C); non-member single constant 50/169 (Task 1, D-D); pre-tax copy with no total claim (Tasks 2-3, D-E); three consumers — offer quotes+persists (Task 2), confirmation reads persisted (Task 3), apply reads persisted (contract section, D-F); failing-first tests for $99->+$40, $79->+$60, $129 50-min->SKIP, unresolvable tier->SKIP, unresolvable rate->SKIP, $119 non-member->+$50/$169, delta<=0->skip, offer+confirmation same delta for a member and a non-member (Tasks 1+4). All covered.
- **Placeholder scan:** every code/test step shows complete code and an exact run command with expected output. No TBD/TODO.
- **Type/name consistency:** result shape `{ deltaDollars, totalDollars, isMember }` and the skip-signal `null` are identical across Tasks 1-4; persisted field names `deltaDollars`/`totalDollars`/`isMember` match between Task 2 (write), Task 3 (read), Task 4 (parity), and the apply-path contract; `resolveUpgradePrice` / `MEMBER_50_MIN_TOTAL` / `NONMEMBER_UPGRADE` named identically in the module, its export block, and the tests.
