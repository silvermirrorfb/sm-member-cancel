# Chatbot Script Decisions for Team Review

**Date:** 2026-05-05
**Source:** Independent review of `General Chatbot Log 022126` (8,660 rows, ~660 sessions, Apr 16 – May 4, 2026)
**Status:** 1 fix already shipped. ~10 open script decisions need a team call.

---

## What we already changed (no decision needed, just FYI)

**Pause-disclosure sequencing**, the bot was offering pauses, getting a "yes," and THEN revealing the 3-billing-cycle commitment in the "I'm setting up..." message. That's a bait-and-switch. Showed up in at least 3 sessions:

- `f0b6be26-7f39-45f4-a8eb-c579f95b8db4` (Nicole), accepted 2-month pause, then learned about commitment, then cancelled outright
- `0352811b-b375-443e-b832-1770c09afad4` (Vanessa), same pattern
- `fe509a7f-093c-4fc0-b66a-59e4efeaa2dd` (Emily), same pattern

The system prompt already said "MUST disclose before confirmation" but the model interpreted "before" loosely. We tightened the rule and added a BAD/GOOD example pair in `src/lib/system-prompt.txt` (lines 488 and 538). Commitment terms now must appear in the SAME message as the offer, with explicit examples to copy.

**No code changes. No test changes. Prompt only.**

---

## Open script decisions, please review and mark each one

For each item: ✅ Approve as proposed | ✏️ Approve with changes | ❌ Reject | 💬 Discuss

---

### Decision 1: How far do we push retention before honoring "just cancel"?

**What we saw:** In session `d60c370e-d8ba-4347-b94a-4151a483c449`, the user said "no I would like to cancel please" and the bot offered a 2-month pause. User said "No thank you - please just cancel" and the bot still went into a final-warning loss-framing block before processing.

**Current rule (HARD RULE 1):** "If 'just cancel' after at least one offer, respect immediately. Final warning."

The "Final warning" step is the friction. It runs even after the user has firmly refused a second time.

**Proposed:**
- After ONE explicit "just cancel" / "no thank you, cancel", skip Final Warning entirely. Confirm and process.
- Keep Final Warning ONLY when the user has accepted no offers AND has not yet clearly said "just cancel."

Decision: ☐ Approve  ☐ Modify  ☐ Reject  ☐ Discuss
Notes:

---

### Decision 2: Cap retention attempts on geographically-impossible cases

**What we saw:** Session `9d661a35-6400-4e20-8521-b2adbba524a9`, user said they're moving to Congo. Bot offered: 1-month pause → bi-monthly billing → "consolidate credits toward Silver Mirror products" → final-warning loss-framing. Four retention attempts before honoring the cancel.

**Proposed:**
- If user states a Relocation reason AND the destination has no Silver Mirror location AND is not in NYC/DC/Miami metro, go straight to Final Warning (or skip even that). Skip pause, skip bi-monthly, skip credit consolidation.
- Add an explicit list of "obviously out of footprint" signals: international moves, states with no SM, "moving abroad."

Decision: ☐ Approve  ☐ Modify  ☐ Reject  ☐ Discuss
Notes:

---

### Decision 3: "I'm passing this to our memberships team", does anything actually happen?

**What we saw:** The bot uses these phrases in nearly every cancellation and pause-cancel session:
- "I'm passing this to our memberships team for backend processing"
- "I've alerted our QA team"
- "I'm flagging this as urgent"
- "You'll receive a confirmation email within 48 hours"

**Answer (verified in code 2026-05-05):** YES, a real integration exists, with three caveats. When `/api/chat/end` is hit with a membership session, `processConversationEnd(summary, transcript)` in `src/lib/notify.js:1242` fires three things in parallel:

1. **Email to `memberships@silvermirror.com`** via SMTP/nodemailer (`sendSummaryEmail`, line 204). Auto-CCs `hello@silvermirror.com` if `member_sentiment` matches `frustrated|angry|upset|hostile|furious|irritated|disappointed`. Reaction cases also CC `EMAIL_REACTION_ALERTS`.
2. **Append to the Cancellations Google Sheet** (`logToGoogleSheets`, env: `GOOGLE_SHEET_ID`).
3. **Reason-category alert email** (`sendReasonAlert`, line 1190), routes by reason category to a per-category recipient list, with subject `[Chat Alert] CANCELLED|RETAINED|NEEDS REVIEW, <name>, <reason>`.

**The three caveats, these are the real risk:**

- **A) Every leg silently skips if env vars are missing.** No `SMTP_HOST/USER/PASS` → email leg returns `{sent: false, reason: 'SMTP not configured'}` and only logs a `console.warn`. Same for `GOOGLE_SHEET_ID`. The bot still tells the user "you'll get an email in 48 hours." We need a prod env-var audit confirming all three legs are wired.
- **B) Trigger requires a successful POST to `/api/chat/end`.** If the user closes the tab, switches networks, or the request 500s before this fires, NONE of the three integrations run, but the user has already been told the team will follow up. The fallback summary block exists (`outcome: 'INCOMPLETE'`), but only if `/end` is called at all.
- **C) "I've alerted our QA team" and "flagged as urgent" map to NOTHING distinct.** There is no separate QA-team alert, no "urgent" flag in the sheet, no Slack integration anywhere in the codebase. Those phrases are pure model output with no side effect beyond the standard summary email. The bot is making up the QA-team alert.

**Proposed:**
- **Confirm prod env vars are set.** Spot-check a recent `CANCELLED` session in the cancellations sheet AND in the memberships@ inbox. If both present, leg 1+2 are real; if not, that's a P0.
- **Add a server-side log line** when env vars are missing (`console.warn` already exists but we should monitor it) so we know in prod when the fallback path silently runs.
- **Strip the bot of unsupported claims.** Remove "I've alerted our QA team" and "I'm flagging this as urgent" from the script unless we wire them to something real (e.g., a separate `EMAIL_QA_ALERTS` env var + recipient).
- **Consider a client-side `sendBeacon`** on tab-close to make leg-A more robust against the "user closes tab" failure mode.

Decision: ☐ Audit env vars + strip QA-team claim (recommended)  ☐ Build new QA-alert integration  ☐ Status quo  ☐ Discuss
Notes:

---

### Decision 4: Specific dollar values for perks ($65 moisturizer, $77 serum, $41 cleanser)

**What we saw:** The bot quotes exact perk dollar values during cancellation:
- "$65 moisturizer" (line 23, session `f0b6be26…`)
- "Hyaluronic Acid Serum worth $77" (line 7333, session `d60c370e…`)
- "Cleanser worth $41" (line 8177, session `9d661a35…`)

**Question:** Are these values pulled live from a perk-value table, or hard-coded in the prompt / inferred by the model?

**Proposed:**
- **If hard-coded:** add them to a single source of truth (a `PERK_VALUES` constant or injected profile field) and reference only that.
- **If model-inferred:** stop quoting dollar values entirely. Use "your Month 2 perk (a moisturizer)" without the price. The risk of being wrong is higher than the retention lift.

Decision: ☐ Add live source  ☐ Drop dollar values  ☐ Already accurate  ☐ Discuss
Notes:

---

### Decision 5: Identity verification floor for account-level actions

**What we saw:** Bot reveals plan, location, price, join month, perks claimed, and rate-lock savings after **name + email only** (e.g., session `0604a88b-d8c8-4095-8070-b2b3c11c3099` lines 697-700). It will then process cancellations / pauses / billing-frequency changes on the same identity check.

**Question for the team:** Is name + email an acceptable verification floor for these actions? Compare against what front desk requires.

**Proposed (pick one):**
- **A) Keep current:** name + email is enough. Document that the 48-hour follow-up email is the second factor.
- **B) Add a soft second factor:** ask for last 4 of card on file, or last appointment date, before processing pause/cancel/billing changes.
- **C) Send confirmation email with a "click to confirm" link**, actual processing only happens after the click. This protects against typos and bad-actor cancellations.

Decision: ☐ A  ☐ B  ☐ C  ☐ Discuss
Notes:

---

### Decision 6: Refund / double-billing escalation path

**What we saw:** Session `25fcb66a-b9a1-474a-9c4f-fddaed9fced8`, user alleges duplicate charges and asks for a full refund. Bot collects identity, says it sees one membership, tells the user to email screenshots. Tone reads as minimizing.

**Proposed script:**
> "I take double-billing very seriously. I see one active membership on your account, but our finance team can pull your full transaction history to investigate. I'm flagging this as a billing dispute, please reply with the dates of the charges you're seeing (you don't need to send card numbers). Our team will follow up within 24 hours with a resolution."

Plus an actual escalation path (see Decision 3).

Decision: ☐ Approve script  ☐ Modify  ☐ Reject  ☐ Discuss
Notes:

---

### Decision 7: Credit-question handling when account data is unavailable

**What we saw:** Session `90d9b96b-faff-4293-b043-e8ab40449c23`, user asks whether a facial credit expiring June 30 was already paid for and whether cancellation loses it. Bot says it can't see specific credit details and gives a generic "credits valid 90 days after cancellation" answer.

**Question:** Should the bot be able to see credit details? If not, the script needs to be more honest about the limitation.

**Proposed (pick one):**
- **A) Wire in credit visibility** so the bot can answer the question directly.
- **B) Explicit "I can't see credit balances" disclaimer** before the cancellation flow, plus auto-routing credit questions to a human within 24 hours.
- **C) Status quo** (bot punts to "memberships team will reach out").

Decision: ☐ A  ☐ B  ☐ C  ☐ Discuss
Notes:

---

#### 🚩 OPEN CONFLICT (added 2026-05-27, Phase 8 audit):

**The current shipped behavior is a hybrid of A and B that nobody explicitly authorized.** Surface this to Matt before any further work on Decision 7.

**What shipped:**
- PR #26 (`fix/retention-softening-and-credit-disclaimer`, May 15) added `HARD RULE - CREDIT VISIBILITY DISCLAIMER` to the system prompt. The bot now leads with an honest "I can see your membership details, but I don't have visibility into your specific credit balances or expiration dates" upfront disclaimer, then routes via the PR #18 standard handoff phrase: "I'm flagging this for our memberships team to review your credits. Someone will follow up with you about next steps." This is the explicit-disclaimer half of Vote B.
- PR #18 / PR #27 / Phase 5 of this branch (HARD RULE - NO HUMAN-TEAM SLA PROMISES) explicitly BAN the "within 24 hours" follow-up promise that was the other half of Vote B. So the shipped behavior dropped the 24-hour SLA without explicit authorization to drop it.

**The conflict:**
- **Per QA_ISSUES.md cancel-bot #14:** "Travis decision (May 15 2026, Decision 7): option B." This is what the May 15 PR cited as the basis for the explicit-disclaimer-plus-handoff approach.
- **Per Matt's audit brief (2026-05-27):** "Travis voted A with 'avoid expired credits, escalate if asked' refinement." This refinement is not reflected anywhere in the shipped prompt, and Option A (wire in credit visibility) would have been a code-build path that nobody has scoped.
- The two accounts of Travis's vote disagree. The shipped behavior is closer to a heavily-trimmed Vote B (disclaimer kept, 24-hour follow-up promise stripped) than to either Travis's stated preference per the May 15 record OR Matt's stated preference per the May 27 audit.

**What "avoid expired credits, escalate if asked" might mean (interpretation, needs Matt's clarification):**
- The bot proactively warns about expired credits before the member asks (e.g., during the post-lookup confirmation message, if the bot's profile data shows the member has unused credits approaching the 90-day expiration window)? This would be an additive change to the post-lookup message; not in current scope.
- OR the bot only mentions credits when the member specifically asks (status quo), and escalates THEN with the handoff phrase. This is closer to current shipped behavior except that Vote A's "wire in credit visibility" code build is not part of the shipped behavior.

**Reconciliation Matt should decide:**

1. **Option B-stripped (current shipped behavior):** Keep PR #26's HARD RULE - CREDIT VISIBILITY DISCLAIMER as-is. The 24-hour follow-up promise was correctly omitted per the broader anti-SLA principle. No further change.

2. **Option A as Matt described it (with the "avoid expired credits, escalate if asked" refinement):** Keep the disclaimer + handoff for member-initiated credit questions. ADD a proactive "you have N unused credits, the earliest expires on [date], you may want to use them before [date]" line to the post-lookup message IF the injected profile data has credit count + expiration date populated. This requires backend work to populate those fields from Boulevard, which is the "wire in credit visibility" piece. Code build, not prompt-only.

3. **Option B as originally specified (Vote B with the 24-hour SLA):** Restore the 24-hour follow-up promise that was stripped. This conflicts with HARD RULE - NO HUMAN-TEAM SLA PROMISES added in Phase 5 of this branch and would need that rule to be relaxed for the credit-question path.

4. **A different option Matt has in mind:** Specify the wording and we'll ship it.

**Recommendation (for Matt to override):** Option 1. The current shipped behavior is operationally clean (no fabricated SLA, honest about the visibility gap, routes to memberships team). Option 2 is also fine but requires a code-build budget that isn't currently allocated. Option 3 conflicts with the anti-SLA principle and should not be selected.

**Note for the auditing AI:** Do NOT auto-resolve this conflict by editing the prompt. Surface it to Matt and wait for his explicit decision.

---

### Decision 8: Voice / tone clean-up, "Perfect!" and scripted empathy

**What we saw:** Three patterns Codex flagged as making the bot sound robotic:
- `"Perfect!"` used as a default acknowledgement, including in unresolved situations (e.g., line 45, bot says "Perfect, Nicole" after the user agrees to wait for a credit lookup)
- Stacked empathy: `"I hear you,"` `"No worries,"` `"That makes sense,"` `"I understand"`, often two or three of them in adjacent messages
- Salesy benefits recital during cancellation: "20% discount on all facials, add-ons, and Silver Mirror products, plus 10% off retail", products and retail likely overlap

**Proposed:**
- **"Perfect!"**, ban as a default acknowledgement. Allow only when something genuinely positive just happened (a retention offer was accepted, a credit was found). Use "Got it," "Done," or no acknowledgement at all otherwise.
- **Empathy phrases**, pick ONE per conversation, not one per turn. Add to TONE & FORMATTING: "Use empathy phrases sparingly, at most once per session."
- **Cancellation benefits list**, shorten to "20% off services and products" (drop the retail-vs-products distinction unless they're actually different).

Decision: ☐ Approve all  ☐ Approve some (mark which)  ☐ Discuss
Notes:

---

### Decision 9: Stop dead-ending to "call (888) 677-0055"

**What we saw:** Session `beac552d…`, user has tried to cancel for six months via email. Bot suggests calling (888) 677-0055. User says "i am working, i cannot call." Only THEN does the bot escalate.

This pattern repeats across booking issues, credit issues, and gift-card issues. The phone number is the bot's escape hatch.

**Proposed:**
- Treat "I've already tried that channel" as an escalation trigger, go straight to creating an internal ticket, not to suggesting another channel.
- Add to HARD RULES: "If the user reports they have already tried email or phone, do NOT redirect them back to the same channel. Escalate directly."

Decision: ☐ Approve  ☐ Modify  ☐ Reject  ☐ Discuss
Notes:

---

### Decision 10: "No minimum commitment" vs the 3-cycle pause/bi-monthly commitment

**What we saw:** Session `7fb9a0da-cab0-46c7-8a1d-3eba9144b281`, bot says memberships have "no minimum commitment, can cancel anytime with 30 days written notice." But pause and bi-monthly create a 3-billing-cycle commitment. These two statements are confusing side-by-side.

**Proposed clarification (work this into both the FAQ answer and the offer copy):**
> "There's no minimum commitment to be a member, you can cancel anytime with 30 days notice. The 3-billing-cycle commitment only applies if you accept a pause or switch to bi-monthly billing, those are special schedules that need a few cycles of regular billing on either side to be sustainable."

Decision: ☐ Approve language  ☐ Modify  ☐ Discuss
Notes:

---

## Items Codex flagged that we are NOT acting on (yet), confirm these are non-issues

These came up in the review but aren't on the decision list. Flag any you want added.

- **Em-dash vs hyphen consistency**, house style call. Not blocking.
- **Repeated "What can I support you with on your membership today?"** after account lookup when the user already stated intent. Annoying but not harmful.
- **Long retention monologues**, partially addressed by Decisions 1 and 2; revisit if still happening after those ship.
- **Hat / Foundational Formulas Bundle perk wording**, assumes these are correct as stated.

---

## Suggested meeting structure (15 min)

1. **5 min**, Walk through the pause-disclosure fix (already shipped). Confirm the GOOD example reads how the team would actually want to talk.
2. **5 min**, Decisions 3 (escalation reality) and 5 (identity verification). These are the two highest-risk items.
3. **5 min**, Decisions 1, 2, 9 (retention guardrails). These are the items most directly affecting how the bot feels in real conversations.
4. **Async after meeting**, Mark up Decisions 4, 6, 7, 8, 10 in this doc.

---

## Appendix, sessions cited in this doc

| Session ID | Issue | Date |
|---|---|---|
| `f0b6be26-7f39-45f4-a8eb-c579f95b8db4` | Pause commitment surprise (Nicole) | 2026-04-16 |
| `0352811b-b375-443e-b832-1770c09afad4` | Pause commitment surprise (Vanessa) | 2026-04-17 |
| `fe509a7f-093c-4fc0-b66a-59e4efeaa2dd` | Pause commitment surprise (Emily) | 2026-05-04 |
| `9d661a35-6400-4e20-8521-b2adbba524a9` | Over-retention on intl. move (Tammy → Congo) | 2026-05-04 |
| `d60c370e-d8ba-4347-b94a-4151a483c449` | Retention after explicit refusal (Christina) | 2026-05-01 |
| `25fcb66a-b9a1-474a-9c4f-fddaed9fced8` | Refund / double-billing escalation | 2026-05-02 |
| `90d9b96b-faff-4293-b043-e8ab40449c23` | Credit visibility gap | 2026-04-16 |
| `0604a88b-d8c8-4095-8070-b2b3c11c3099` | Identity verification floor | 2026-04-19 |
| `7fb9a0da-cab0-46c7-8a1d-3eba9144b281` | Conflicting commitment messaging | 2026-05-03 |
| `beac552d-856f-442e-b0ff-c954b264760c` | Dead-end to phone after email failed | 2026-05-04 |
| `ddb736c1-3f37-4893-b7a9-acaa6731bb5c` | "Confirming cancellation" reads as final | 2026-05-01 |
