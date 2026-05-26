# Chatbot Log Fixes (Week of 2026-05-20 to 2026-05-26) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four chatbot regressions surfaced by the past week of General Chatbot logs (108 sessions, 600 messages, 2026-05-20 to 2026-05-26): (1) system prompt em-dash regression, (2) HydraFacial framing + proactive-mention bug, (3) bi-monthly pricing drift, (4) missing global guard for "Experience Ambassador" / "Support Ambassador" titles in customer-facing language. Add regression tests so none can silently come back.

**Architecture:** Pure system-prompt and test-suite changes in `~/sm-member-cancel`. No runtime code changes; the bi-monthly pricing constant `CURRENT_BIMONTHLY_PRICING` already exists in `src/lib/member-draft.js:12` and is used correctly by email drafts — the bug is that the chat-time verbal flow (governed by `src/lib/system-prompt.txt`) lacks an explicit HARD RULE forbidding the member's grandfathered monthly rate as the bi-monthly price. The chatbot reads `src/lib/system-prompt.txt` at startup; rewriting that file and shipping is the entire fix.

**Tech Stack:** Node.js, Vitest, Next.js (existing repo). No new dependencies.

**Scope note — what this plan does NOT cover (each needs its own plan):**
- **[HIGHEST PRIORITY PUNT] Booking error telemetry.** Six distinct sessions this week ("why can't I book", "promo code invalid", "card rejected", "wrong number", etc.) hit real production bugs and were silently routed to phone with no engineering signal. This is the next plan to write after the current Step 0.5 SMS-webhook PR ships.
- Promo / discount awareness gap (3+ sessions asked about specific promos, bot has no data source).
- Account integration gap (credits, vouchers, account history not visible to bot).
- Cancel save-flow authority audit (session 0b05614b offered $50 Custom Jelly Mask add-on; confirm policy).

All four are captured in `docs/CHATBOT_FOLLOWUPS_2026-05-26.md` (created in Task 9).

---

## File Structure

**Modify:**
- `src/lib/system-prompt.txt` — replace all 98 em dashes (U+2014) with commas/colons/parens; rewrite HydraFacial block (lines 88-90) to drop "quality issues" framing and add a do-not-volunteer rule; add an explicit HARD RULE that bi-monthly always uses current $99/$169 pricing regardless of member's grandfathered monthly rate.

**Create:**
- `__tests__/system-prompt-no-em-dashes.test.js` — global guard. Reads `src/lib/system-prompt.txt`, asserts zero `—` (U+2014) and zero `–` (U+2013) anywhere.
- `__tests__/system-prompt-hydrafacial-framing.test.js` — asserts the HydraFacial block: (a) does not contain "quality issues" or "had quality" or "quality decline", (b) still has Hydradermabrasion + upgrade messaging, (c) contains a do-not-proactively-mention rule.
- `__tests__/system-prompt-bimonthly-pricing.test.js` — asserts the bi-monthly section: (a) explicitly states $99 (30-min) and $169 (50-min), (b) contains a HARD RULE forbidding grandfathered/current monthly rate use for bi-monthly offers, (c) does not tie bi-monthly pricing to "your current rate" / "your locked rate" / "your existing rate".
- `__tests__/system-prompt-ambassador-titles-guard.test.js` — asserts that the HARD RULE forbidding "Experience Ambassador" and "Support Ambassador" in member-facing output is still present in the file (regression catch if someone deletes the rule during a refactor).
- `docs/CHATBOT_FOLLOWUPS_2026-05-26.md` — captures punted items above with booking-error telemetry flagged as highest priority.

**No changes to:** runtime chat code, Boulevard client, Twilio webhook, `member-draft.js` (its bi-monthly pricing is already correct).

---

## Branching

Current working tree is on `fix/sms-webhook-phone-lookup-redis-index` (Step 0.5 SMS work holding for ship approval). This work is unrelated — branch from `main` and ship in parallel.

```bash
cd ~/sm-member-cancel
git stash push -u -m "WIP sms-webhook fixes" # preserve current working tree
git checkout main
git pull --ff-only origin main
git checkout -b fix/chatbot-system-prompt-log-review-2026-05-26
```

After this plan's PR is merged, restore the SMS-webhook WIP:

```bash
git checkout fix/sms-webhook-phone-lookup-redis-index
git stash pop
```

---

### Task 1: Write the failing test for em-dash regression

**Files:**
- Create: `__tests__/system-prompt-no-em-dashes.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// __tests__/system-prompt-no-em-dashes.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: zero em dashes or en dashes anywhere in the file', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('contains no em dash characters (U+2014)', () => {
    const offending = prompt
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('—'));
    expect(
      offending,
      `Found em dashes on lines: ${offending.map((o) => o.line).join(', ')}.\n` +
        `First offender (line ${offending[0]?.line}): ${offending[0]?.text}`,
    ).toEqual([]);
  });

  it('contains no en dash characters (U+2013)', () => {
    const offending = prompt
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('–'));
    expect(
      offending,
      `Found en dashes on lines: ${offending.map((o) => o.line).join(', ')}.`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/sm-member-cancel
npx vitest run __tests__/system-prompt-no-em-dashes.test.js
```

Expected: FAIL with "Found em dashes on lines: 30, 32, 34, ...". 98 occurrences confirmed during plan prep.

- [ ] **Step 3: Commit the failing test**

```bash
git add __tests__/system-prompt-no-em-dashes.test.js
git commit -m "test(prompt): guard against em/en dashes anywhere in system-prompt.txt"
```

---

### Task 2: Make the em-dash test pass

**Files:**
- Modify: `src/lib/system-prompt.txt` (all 98 em-dash lines)

**Rewrite rules (apply uniformly):**

| Pattern | Replace with |
| --- | --- |
| `Service Name — Description.` | `Service Name: Description.` |
| `$95 — 15 min — Description.` | `$95 (15 min). Description.` |
| `Best for: X — do NOT recommend...` | `Best for: X. Do NOT recommend...` |
| `30-MINUTE FACIALS — {{WALKIN_30}} walk-in / {{MEMBER_30}} membership` | `30-MINUTE FACIALS ({{WALKIN_30}} walk-in / {{MEMBER_30}} membership)` |
| Any other `—` | Comma, period, parenthesis, or colon, whichever reads most naturally. |

Read each line and pick punctuation that keeps the sentence natural — do not mechanically swap. The point is to remove the visual cue the LLM is copying.

- [ ] **Step 1: Get the full list of offending lines**

```bash
cd ~/sm-member-cancel
grep -n '—\|–' src/lib/system-prompt.txt > /tmp/em-dash-lines.txt
wc -l /tmp/em-dash-lines.txt
```

Expected: ~98 lines.

- [ ] **Step 2: Edit `src/lib/system-prompt.txt`**

Concrete examples:

Before (line 34):
```
Signature Facial — The go-to facial for skin maintenance. Thorough cleanse, gentle exfoliation, oxygen infusion. Great for first-timers and regular upkeep. Best for: all skin types, dullness, congestion.
```

After:
```
Signature Facial: the go-to facial for skin maintenance. Thorough cleanse, gentle exfoliation, oxygen infusion. Great for first-timers and regular upkeep. Best for: all skin types, dullness, congestion.
```

Before (line 67):
```
- Dermaplaning — $95 (member $76) — 15 min — Professional-grade blade removes dead skin + vellus hair. Not for active acne. Best for: texture, roughness, dullness.
```

After:
```
- Dermaplaning: $95 (member $76), 15 min. Professional-grade blade removes dead skin and vellus hair. Not for active acne. Best for: texture, roughness, dullness.
```

Before (line 13, the rule's own examples):
```
- NEVER use em dashes (—) or en dashes (–) in any response. Zero exceptions. Use commas, periods, parentheses, or colons instead. Examples of correct replacements: "Signature Facial (30 min, $119), great for first-timers" NOT "Signature Facial (30 min, $119) — great for first-timers". ...
```

After (describe the characters by Unicode codepoint so the file itself contains zero literal em/en dashes):
```
- NEVER use em dashes (U+2014) or en dashes (U+2013) in any response. Zero exceptions. Use commas, periods, parentheses, or colons instead. Examples of correct replacements: "Signature Facial (30 min, $119), great for first-timers" NOT "Signature Facial (30 min, $119), great for first-timers" using an em dash. ...
```

- [ ] **Step 3: Verify the em-dash test now passes**

```bash
npx vitest run __tests__/system-prompt-no-em-dashes.test.js
```

Expected: PASS, both assertions.

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run
```

Expected: all green. If any pre-existing scoped em-dash tests (`claude.test.js` lines 489, 749, 1108, 1535, 1914) now reference different line content but still pass, that is fine. If anything fails, fix the prompt edit (not the test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/system-prompt.txt
git commit -m "fix(prompt): replace all 98 em dashes with commas/colons/parens; root cause of em-dash leakage (week of 2026-05-20)"
```

---

### Task 3: Write the failing test for HydraFacial framing + proactive-mention

**Files:**
- Create: `__tests__/system-prompt-hydrafacial-framing.test.js`

**Background — why this changed from the original plan:** In session 75cff478 (2026-05-22), the user asked about facial combinations and did NOT mention HydraFacial. The bot proactively volunteered "Hydradermabrasion is our upgrade replacement for HydraFacial". The amended fix: HydraFacial should only be referenced when the user mentions it first.

- [ ] **Step 1: Write the failing test**

```javascript
// __tests__/system-prompt-hydrafacial-framing.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: HydraFacial framing is upgrade-focused, not competitor-bashing', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('does not say HydraFacial "had quality issues" or similar', () => {
    expect(prompt).not.toMatch(/quality issues/i);
    expect(prompt).not.toMatch(/had quality/i);
    expect(prompt).not.toMatch(/quality decline/i);
    expect(prompt).not.toMatch(/product line had/i);
  });

  it('still describes Hydradermabrasion as the current offering', () => {
    expect(prompt).toMatch(/Hydradermabrasion/);
  });

  it('still tells the bot how to respond when asked about HydraFacial', () => {
    expect(prompt.toLowerCase()).toContain('hydrafacial');
    expect(prompt.toLowerCase()).toMatch(/upgraded|upgrade/);
  });

  it('contains an explicit do-not-proactively-mention HydraFacial rule', () => {
    // Production regression: session 75cff478 (2026-05-22) — user asked about
    // facial combos, bot volunteered "Hydradermabrasion is our upgrade
    // replacement for HydraFacial" with no HydraFacial mention from the user.
    // Bot must wait for user to bring it up first.
    expect(prompt.toLowerCase()).toMatch(
      /only mention hydrafacial if the user mentions it first|do not proactively (mention|bring up) hydrafacial|never volunteer hydrafacial/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run __tests__/system-prompt-hydrafacial-framing.test.js
```

Expected: FAIL on the first assertion (current line 88 contains "product quality decline", line 90 contains "the HydraFacial product line had quality issues") and on the fourth assertion (no do-not-proactively-mention rule exists yet).

- [ ] **Step 3: Commit the failing test**

```bash
git add __tests__/system-prompt-hydrafacial-framing.test.js
git commit -m "test(prompt): guard HydraFacial framing against competitor-bashing + proactive mention"
```

---

### Task 4: Rewrite the HydraFacial block in `src/lib/system-prompt.txt`

**Files:**
- Modify: `src/lib/system-prompt.txt:87-90`

- [ ] **Step 1: Replace lines 87-90**

Find the block (lines may have shifted ±1 by now if Task 2 introduced any line splits; locate by content):

```
Silver Mirror NO LONGER offers HydraFacial. We discontinued it due to product quality decline and upgraded to the most advanced Hydradermabrasion technology available.

If a customer asks about HydraFacial, respond: "We actually upgraded from HydraFacial to a more advanced Hydradermabrasion system, the HydraFacial product line had quality issues, so we invested in better technology that delivers deeper exfoliation and more intense hydration. You can add Hydradermabrasion to any facial during booking for $95."
```

(After Task 2's em-dash sweep, the original em dash inside the quoted response will already be a comma. The "quality issues" phrasing is what we're now replacing.)

Replace with:

```
Silver Mirror NO LONGER offers HydraFacial. We upgraded to Hydradermabrasion, which delivers deeper exfoliation and more intense hydration than the older technology.

HARD RULE: only mention HydraFacial if the user mentions it first. Do not proactively bring up HydraFacial when describing Hydradermabrasion or any other service. When describing Hydradermabrasion in any context where the user has not said "HydraFacial," describe it on its own terms (diamond-tip dermabrasion, pressurized serum infusion, results) without referencing the discontinued product.

If a customer mentions HydraFacial first, respond: "We upgraded from HydraFacial to Hydradermabrasion, a more advanced system that delivers deeper exfoliation and more intense hydration. You can add Hydradermabrasion to any facial during booking for $95."
```

Also check line 68 (the Hydradermabrasion add-on entry). It currently reads:
```
- Hydradermabrasion: $95 (member $76), 20 min. Diamond-tip dermabrasion + pressurized serum infusion. Our upgrade replacement for HydraFacial. Best for: dryness, dehydration, congestion.
```

Remove the "Our upgrade replacement for HydraFacial." sentence so the description stands on its own:
```
- Hydradermabrasion: $95 (member $76), 20 min. Diamond-tip dermabrasion plus pressurized serum infusion for deeper exfoliation and intense hydration. Best for: dryness, dehydration, congestion.
```

- [ ] **Step 2: Verify the HydraFacial test passes**

```bash
npx vitest run __tests__/system-prompt-hydrafacial-framing.test.js
```

Expected: PASS, all four assertions.

- [ ] **Step 3: Re-run em-dash test**

```bash
npx vitest run __tests__/system-prompt-no-em-dashes.test.js
```

Expected: PASS.

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/system-prompt.txt
git commit -m "fix(prompt): soften HydraFacial framing + forbid proactive mention; addresses session 75cff478 (2026-05-22)"
```

---

### Task 5: Write the failing test for bi-monthly pricing rule

**Files:**
- Create: `__tests__/system-prompt-bimonthly-pricing.test.js`

**Background:** Travis confirmed on 2026-05-19 that current bi-monthly pricing is $99 (30-min) and $169 (50-min). The Donna Sommer case on 2026-05-20 surfaced the bot quoting the member's existing monthly rate as the bi-monthly price. The constant `CURRENT_BIMONTHLY_PRICING` already exists in `src/lib/member-draft.js:12` with correct values and powers email drafts correctly — the gap is in the chat-time verbal flow, governed by `system-prompt.txt`. The prompt currently mentions $99/$169 once on line 569 but has no HARD RULE against using grandfathered/current monthly rates as the bi-monthly price.

- [ ] **Step 1: Write the failing test**

```javascript
// __tests__/system-prompt-bimonthly-pricing.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: bi-monthly pricing is fixed at current rates, not member rate', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('explicitly quotes $99 for 30-min bi-monthly and $169 for 50-min bi-monthly', () => {
    // Match within ~80 chars of the word "bi-monthly" / "bimonthly" so we
    // confirm the numbers are paired with the offer, not just floating
    // somewhere else in the prompt.
    expect(prompt).toMatch(/bi.?monthly[\s\S]{0,200}\$99[\s\S]{0,200}\$169/i);
  });

  it('contains a HARD RULE that bi-monthly uses current $99/$169 pricing, never the member rate', () => {
    // Production regression: Donna Sommer (2026-05-20). Bot quoted member's
    // grandfathered monthly rate as the bi-monthly price. The rule must be
    // explicit and discoverable by the model at retrieval time.
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(
      /hard rule.{0,200}bi.?monthly|bi.?monthly.{0,400}hard rule/i,
    );
    expect(lower).toMatch(/never (use|quote) (the )?member.{0,40}(rate|price|pricing)/i);
  });

  it('does NOT tie bi-monthly pricing to the member\'s existing/grandfathered/locked rate', () => {
    // Negative assertions: any sentence that links bi-monthly to "your
    // current rate" / "your locked rate" / "your existing rate" is the
    // exact regression we are guarding against.
    const lower = prompt.toLowerCase();
    const offenders = [
      /bi.?monthly.{0,80}your (current|locked|existing|grandfathered) (rate|price|pricing)/,
      /your (current|locked|existing|grandfathered) (rate|price|pricing).{0,80}bi.?monthly/,
      /bi.?monthly.{0,80}at (your|the member.?s) (rate|price|pricing)/,
    ];
    for (const pat of offenders) {
      expect(prompt.toLowerCase(), `pattern matched: ${pat}`).not.toMatch(pat);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify partial failure**

```bash
npx vitest run __tests__/system-prompt-bimonthly-pricing.test.js
```

Expected:
- First assertion: PASS (line 569 already pairs bi-monthly with $99/$169).
- Second assertion: FAIL (no HARD RULE exists yet).
- Third assertion: likely PASS (sanity check; if it fails we have an even worse bug).

- [ ] **Step 3: Commit the failing test**

```bash
git add __tests__/system-prompt-bimonthly-pricing.test.js
git commit -m "test(prompt): guard bi-monthly pricing rule; surfaced by Donna Sommer 2026-05-20"
```

---

### Task 6: Add the bi-monthly HARD RULE to `src/lib/system-prompt.txt`

**Files:**
- Modify: `src/lib/system-prompt.txt` — add a new HARD RULE block near the existing bi-monthly offer text (line ~569). The cleanest place is immediately after the bi-monthly offer line in the decision tree so the rule sits adjacent to where the model retrieves the offer.

- [ ] **Step 1: Locate the bi-monthly offer line**

```bash
grep -n "Bi-monthly:" src/lib/system-prompt.txt | head -3
```

Expected: line 569 (or close to it; may have shifted by Task 2/4 edits).

- [ ] **Step 2: Insert the HARD RULE block immediately after the bi-monthly offer line**

The existing offer line (currently line 569) reads:
```
17. Bi-monthly: "Another option is switching to bi-monthly at our current pricing: $99 for 30-minute facials or $169 for 50-minute facials. This keeps membership active and perks going with every-other-month billing. There is no minimum commitment to be a member, but the 3-billing-cycle commitment applies if you switch to bi-monthly billing. Those are special schedules that need a few cycles of regular billing on either side to work." Do not tie this offer to prior membership pricing.
```

Immediately AFTER that line, insert:

```

HARD RULE - BI-MONTHLY PRICING IS FIXED, NEVER THE MEMBER'S RATE
Bi-monthly pricing is ALWAYS $99 for 30-minute facials and $169 for 50-minute facials. These are the current bi-monthly rates confirmed by Travis (Director of Operations, 2026-05-19) and are the ONLY rates the bot quotes for bi-monthly offers. NEVER use the member's current monthly rate, their grandfathered rate, their locked rate, or any other personalized rate as the bi-monthly price. The member's monthly rate is what they pay for monthly billing. Bi-monthly is a different schedule with different fixed pricing. When the duration of the member's tier is known (30-minute or 50-minute), quote the matching bi-monthly rate ($99 or $169). When the duration is unknown or ambiguous, show both: "$99 for 30-minute facials or $169 for 50-minute facials". This rule applies whether the member is grandfathered into older monthly pricing, on a promo monthly rate, or on the current monthly rate. Bi-monthly pricing does not depend on the member's history; it is the same for everyone. Production regression this rule exists to prevent: Donna Sommer (2026-05-20) was quoted her existing monthly rate as the bi-monthly price.
```

- [ ] **Step 3: Verify all three bi-monthly assertions pass**

```bash
npx vitest run __tests__/system-prompt-bimonthly-pricing.test.js
```

Expected: PASS, all three assertions.

- [ ] **Step 4: Re-run earlier tests to confirm no regression**

```bash
npx vitest run __tests__/system-prompt-no-em-dashes.test.js __tests__/system-prompt-hydrafacial-framing.test.js
```

Expected: PASS for both files.

- [ ] **Step 5: Run the full test suite**

```bash
npx vitest run
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/system-prompt.txt
git commit -m "fix(prompt): add HARD RULE that bi-monthly pricing is fixed at \$99/\$169; addresses Donna Sommer 2026-05-20"
```

---

### Task 7: Write the global Ambassador-titles guard test

**Files:**
- Create: `__tests__/system-prompt-ambassador-titles-guard.test.js`

**Background:** Commits 244978f + a69d4a0 (2026-05-19) patched the cancellation tree to forbid fabricated staff names, roles, and connection programs. The HARD RULE that bans "Experience Ambassador" / "Support Ambassador" in member-facing output currently lives at line 568 of `system-prompt.txt` and is referenced again at lines 597-602, 614, 663. Booking and lead-lookup flows were never explicitly verified. If a future refactor strips the HARD RULE, the bot loses the only thing keeping it from surfacing those titles in customer-facing dialog. This test catches that deletion.

This is a regression guard, not a fix. It should pass immediately when written (the rule is in the prompt today). If anyone deletes the rule in a future PR, this test catches it.

- [ ] **Step 1: Write the test**

```javascript
// __tests__/system-prompt-ambassador-titles-guard.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system prompt: HARD RULE forbidding Experience/Support Ambassador titles in member-facing output is present', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/lib/system-prompt.txt'),
    'utf8',
  );

  it('contains the explicit forbid-titles instruction', () => {
    // The exact phrasing is per commits 244978f + a69d4a0 (2026-05-19): the
    // prompt instructs the bot NOT to use "Experience Ambassador" or "Support
    // Ambassador" in member-facing output. This regex tolerates minor wording
    // changes ("do NOT use the titles" / "must not use" / "never use") but
    // requires both literal titles in the same forbid-instruction.
    expect(prompt).toMatch(
      /(do NOT use|must not use|never use|do not surface)[\s\S]{0,200}"?Experience Ambassador"?[\s\S]{0,200}"?Support Ambassador"?/i,
    );
  });

  it('contains the HARD RULE block governing fabricated staff names, roles, and connection programs', () => {
    // Sanity: the rule's parent section is named and present, so the entire
    // safety net (not just the specific titles line) survives refactors.
    expect(prompt).toMatch(/HARD RULE.{0,80}NO FABRICATED STAFF NAMES/i);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run __tests__/system-prompt-ambassador-titles-guard.test.js
```

Expected: PASS, both assertions. (The rule is in the prompt today.) If it fails, do NOT change the test — read the prompt, find where the rule moved, and fix the test's regex to match current wording. If the rule itself is genuinely missing, that's a real regression to investigate before moving on.

- [ ] **Step 3: Commit**

```bash
git add __tests__/system-prompt-ambassador-titles-guard.test.js
git commit -m "test(prompt): guard Experience/Support Ambassador titles rule against accidental deletion"
```

---

### Task 8: Run the full suite as a final consolidation check

- [ ] **Step 1: Run the full suite**

```bash
cd ~/sm-member-cancel
npx vitest run
```

Expected: all green. The four new test files add ~10 new test cases (em-dash 2, HydraFacial 4, bi-monthly 3, Ambassador 2). Confirm the previously-passing suite still passes plus the new files.

If anything red, fix the prompt edit that caused the regression (do NOT loosen a test to make it pass).

- [ ] **Step 2: No commit needed if green. Continue to Task 9.**

---

### Task 9: Capture punted follow-ups (booking-error telemetry flagged highest priority)

**Files:**
- Create: `docs/CHATBOT_FOLLOWUPS_2026-05-26.md`

- [ ] **Step 1: Write the follow-up doc**

```markdown
# Chatbot Follow-Ups from Week of 2026-05-20 Log Review

Issues identified in the General Chatbot log review on 2026-05-26 that are
out of scope for the same-day system-prompt fix and need their own plans.

## 1. [HIGHEST PRIORITY] Booking error telemetry (6 sessions)

**Priority rationale:** Six distinct sessions this week hit real production
bugs ("why can't I book", "promo code invalid", "card keeps getting
rejected", "wrong number", "unconfirmed at the top of the forms", "promo
code says invalid"). Bot routed every one of them to (888) 677-0055 or
hello@silvermirror.com. Engineering had zero signal. We only learned about
these by manually reviewing the chat log a week later. This is the
highest-leverage punted item in this list and should be the next plan
to write after the current Step 0.5 SMS-webhook PR ships.

**Sessions:** e1511782 (2026-05-21), f668a8d1 (2026-05-22), d7167eb3
(2026-05-22), 75cff478 (2026-05-22), 14c51ad6 (2026-05-25), and the
booking-related portion of others.

**Plan to write:** A booking-error sink. When the bot detects one of these
symptoms (most likely via a tagged tool call in the chat handler), it
fires an event to something monitorable (Slack channel #booking-bugs, a
Sentry custom event, or a Supabase row) carrying: session ID, the user
message, the bot's routing response, location if mentioned, and the
symptom category (payment failure, promo code, booking calendar, phone
number, etc.). Goal: engineering learns about these in hours, not weeks.

## 2. Promo / discount awareness gap (3+ sessions)

**Symptom:** Users ask "$20 off code", "when is the 40 off", "is there a
first-time discount?" Bot correctly says "I don't have that info" and
routes to email. Real gap: bot has no data source for active promos.

**Sessions:** 150625ca (2026-05-21), 69fd282f (2026-05-21), a2f989c9
(2026-05-24).

**Decision needed (Matt):** Do we want the bot to know current promos? If
yes, options are (a) a `CURRENT_PROMOS` env var the prompt interpolates,
(b) a Klaviyo / Boulevard promo-feed integration, or (c) keep silent and
explicitly tell users to check the website. Cheapest is (a).

## 3. Account / credits / vouchers integration gap (4+ sessions)

**Symptom:** Bot can read membership tier (Boulevard integration exists
for that) but says "I don't have visibility into your specific credit
balance" / "expired vouchers" / "account history". User must wait for a
human follow-up.

**Sessions:** 44e0f0e9 (2026-05-21), b46bc078 (2026-05-24), 0b05614b
(2026-05-25), and the cancel flow in general.

**Decision needed:** Scope a Boulevard account-data fetch (credits,
vouchers, transaction history) into the chat context. Several days of
work; probably wants its own brainstorm before planning.

## 4. Cancel save-flow authority audit (1 session)

**Symptom:** Session 0b05614b (2026-05-25, Angela Li / Flatiron 50-min).
User said "too salesy" as cancel reason. Bot offered a complimentary
Custom Jelly Mask ($50 value) add-on as a save attempt. User accepted,
kept membership.

**Decision needed (Matt):** Is the bot authorized to give a $50 add-on as
a save offer? If yes, no action. If no, the save flow needs a
cheaper-or-cap policy in the system prompt.

## 5. False positives discarded

For the record, these flagged in the analysis but are NOT bugs:

- "undefined/null/NaN" matches (19 hits) were all false positives from
  the regex over substrings ("skin maintenance", "pregnancy-safe", etc.).
- "Medical language" matches (40 hits) were almost all the word
  "treatment" used in a cosmetic context, which is allowed.
- Cancel-rebook regression (1 hit, session a4623d4b) was already fixed
  by commit 2937307 before this log window.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CHATBOT_FOLLOWUPS_2026-05-26.md
git commit -m "docs: capture chatbot follow-ups from 2026-05-20 log review; flag booking-error telemetry as highest priority"
```

---

### Task 10: Smoke-test the bot end-to-end before shipping

**Files:** none modified. Read-only check.

- [ ] **Step 1: Run the dev server**

```bash
cd ~/sm-member-cancel
pnpm dev
```

Watch console for "failed to load system prompt" / template parse errors.

- [ ] **Step 2: Hit the chat endpoint with three smoke messages**

In a second terminal:

```bash
# 2a: HydraFacial mention should still route correctly when user asks first
curl -s -X POST http://localhost:3000/api/chat/start \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Do you offer HydraFacials?"}]}' \
  | head -c 800

# 2b: Hydradermabrasion-only ask should NOT volunteer HydraFacial
curl -s -X POST http://localhost:3000/api/chat/start \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Tell me about Hydradermabrasion."}]}' \
  | head -c 800

# 2c: Bi-monthly ask should quote $99 / $169, not a personalized rate
curl -s -X POST http://localhost:3000/api/chat/start \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"How much is bi-monthly billing?"}]}' \
  | head -c 800
```

Expected:
- 2a mentions Hydradermabrasion + upgrade and does NOT contain `—` or "quality issues".
- 2b describes Hydradermabrasion on its own terms and does NOT mention HydraFacial.
- 2c quotes $99 (30-min) and $169 (50-min) and does NOT quote a member's locked/grandfathered rate.

If the endpoint path differs, check `src/app/api/` for the actual route. The path is not load-bearing; the point is to confirm the bot still responds correctly.

- [ ] **Step 3: Stop the dev server (`Ctrl-C`).**

- [ ] **Step 4: HOLD FOR SHIP APPROVAL.** Do not push or open a PR. Report to Matt that all tests are green, smoke tests pass, and the branch is ready to ship. Wait for explicit ship approval before continuing to Task 11.

---

### Task 11: Push and open the PR (only after explicit ship approval)

- [ ] **Step 1: Push the branch**

```bash
cd ~/sm-member-cancel
git push -u origin fix/chatbot-system-prompt-log-review-2026-05-26
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "fix(prompt): em dashes, HydraFacial framing, bi-monthly pricing, Ambassador guard (log review 2026-05-20 → 26)" --body "$(cat <<'EOF'
## Summary
Four chatbot regressions surfaced by the 2026-05-20 to 2026-05-26 General Chatbot log review (108 sessions, 600 messages):

- **Em dashes:** Replace all 98 em dashes in `src/lib/system-prompt.txt`. The prompt forbade them on line 13 while modeling them on 97 other lines, so the LLM was copying the example syntax. 22 assistant messages this week had em dashes; this is the root cause.
- **HydraFacial framing + proactive mention:** Drop "product line had quality issues" framing. Add HARD RULE that the bot only mentions HydraFacial if the user mentions it first. Session 75cff478 (2026-05-22) had the bot proactively saying "Hydradermabrasion is our upgrade replacement for HydraFacial" when the user did NOT mention HydraFacial.
- **Bi-monthly pricing:** Add HARD RULE that bi-monthly is fixed at \$99 (30-min) and \$169 (50-min), never the member's monthly/locked/grandfathered rate. Surfaced by Donna Sommer 2026-05-20.
- **Ambassador titles guard:** Add global regression test that the HARD RULE forbidding "Experience Ambassador" / "Support Ambassador" titles in member-facing output stays in the prompt. Booking and lead-lookup flows were never explicitly verified after 244978f + a69d4a0.

Plus `docs/CHATBOT_FOLLOWUPS_2026-05-26.md` capturing punted items, with **booking-error telemetry flagged as highest priority** (6 sessions of real production bugs with zero engineering signal).

## Test plan
- [x] `npx vitest run __tests__/system-prompt-no-em-dashes.test.js` passes (2 assertions)
- [x] `npx vitest run __tests__/system-prompt-hydrafacial-framing.test.js` passes (4 assertions, including new do-not-proactively-mention rule)
- [x] `npx vitest run __tests__/system-prompt-bimonthly-pricing.test.js` passes (3 assertions)
- [x] `npx vitest run __tests__/system-prompt-ambassador-titles-guard.test.js` passes (2 assertions)
- [x] `npx vitest run` (full suite) passes
- [x] Local dev server smoke: HydraFacial-asked response has no em dashes, no "quality issues" phrase; Hydradermabrasion-only response does NOT mention HydraFacial; bi-monthly response quotes \$99 / \$169
EOF
)"
```

Return the PR URL.

- [ ] **Step 3: Restore the pre-existing WIP branch**

```bash
git checkout fix/sms-webhook-phone-lookup-redis-index
git stash pop
```

Confirm the SMS webhook WIP is back in the working tree (`git status` should show the same 4 modified files and the same untracked test files as before).

---

## Self-Review Checklist

**Spec coverage:**
- Em-dash regression → Tasks 1, 2 ✓
- HydraFacial framing → Tasks 3, 4 ✓
- HydraFacial proactive-mention amendment → Tasks 3, 4 (4th assertion in Task 3, HARD RULE in Task 4) ✓
- Bi-monthly pricing fix → Tasks 5, 6 ✓
- Bi-monthly regression test asserting no grandfathered/monthly-rate use → Task 5, third assertion ✓
- Ambassador-titles global guard → Task 7 ✓
- Booking-error telemetry priority marker → Task 9, item 1, marked "[HIGHEST PRIORITY]" ✓
- Smoke test → Task 10 ✓
- HOLD FOR SHIP APPROVAL gate → Task 10, Step 4 ✓
- Ship → Task 11 ✓
- WIP branch restored → Task 11, Step 3 ✓

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "add appropriate error handling" anywhere. Rewrite rules in Task 2 give the engineer concrete patterns plus 3 worked examples. Tasks 4, 6 provide exact before/after blocks. Task 9 doc is fully written.

**Type consistency:** Test file names referenced consistently across tasks. Branch name consistent throughout (`fix/chatbot-system-prompt-log-review-2026-05-26`). Prompt file path consistent (`src/lib/system-prompt.txt`). The bi-monthly constant `CURRENT_BIMONTHLY_PRICING` referenced in the architecture section matches its actual location at `src/lib/member-draft.js:12`.
