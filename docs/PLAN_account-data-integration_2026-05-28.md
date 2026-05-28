# Plan: Account Data Integration (credits, vouchers, transaction history)

**Status:** PROPOSAL. No code in this plan. Matt reviews and decides.
**Author:** Claude Code (autonomous phase 3 of the 2026-05-28 sweep)
**Companion docs:** `CLAUDE.md`, `QA_ISSUES.md`, `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md` (esp. Decision 7)

---

## 1. The gap

The cancellation chatbot can read **membership tier, monthly rate, tenure, perks claimed, last visit, next charge date, last bill date, and a coarse `unusedCredits` count**. It CANNOT read:

- Credit balance broken down by type (membership credit vs. promo credit vs. enhancement credit vs. gift card)
- Voucher / gift card balance and expiry
- Transaction history (recent purchases, refunds, declined charges)
- Account balance owed (overdue invoices)
- Specific credit expiry dates (today's logic infers `lastBillDate + 90` for all credits, which is wrong for gift cards and promo credits)

**How often it bites:** at least 4 session log entries reviewed in the 2026-05 sweep hit this. The bot says some variant of "I can't see your specific credit balance" and routes the member to a human. Members wait. Decision 7 is unresolved precisely because the bot cannot answer the question the policy decision is about. Until the data is there, picking option A vs B vs C is academic.

Today the lookup path returns `unusedCredits: 2` (a raw count) without dollar value, type breakdown, or per-credit expiry. The bot's text references "$50 Enhancement Credit" perks as STATIC content from `PERKS` in `src/lib/boulevard.js`, not as a query against the member's actual unused enhancement credits.

---

## 2. What Boulevard exposes (read-only investigation summary)

This section needs **active Boulevard schema introspection** before any build kicks off. Until that probe is run, the items below are best-guess based on the existing client code patterns in `src/lib/boulevard.js` (we already query `client`, `memberships`, `appointments`, and Boulevard's introspection metadata is verified working there).

Likely available on Boulevard's `Client` type or related:
- `accountBalance` (typically a scalar money type with currency)
- `giftCardBalance` (often a separate `GiftCardAccount` collection per client)
- `vouchers` / `vouchersConnection` (some Boulevard tenants have a `Voucher` type with redeemableAmount, expiresOn, status)
- `transactions` / `transactionsConnection` (each transaction has type, amount, date, status, refunds)
- `accountCredits` (one-off credits issued by staff, separate from gift cards)

What we know does NOT exist (per Travis confirmation logged in commit history):
- A single "all account balances" rollup query. The bot has to combine memberships, gift cards, vouchers, and account credits manually.
- An expiry-aware "show me my available balance to spend right now" query. Has to compute against `expiresOn`.

**Required before build starts:** introspection probe of Boulevard's `Client` type and related (vouchers, gift cards, account credits, transactions). Capture the actual field names, types, args, and pagination shape. Save as a fixture in `docs/boulevard-account-data-schema_2026-MM-DD.json` for the implementation tickets to reference. This is the same pattern `scanAppointments` uses (`getTypeFieldSet` + `getTypeFieldDetailMap`) and the same `introspectionResponse` shape the Bug 4 test fixtures use.

Note for the probe: do NOT issue MUTATIONS during the probe, and keep the probe behind the existing `BOULEVARD_API_*` env auth. Read-only.

---

## 3. Architecture options

### Option A: Fetch-on-demand
**How:** When a member asks "what's my credit balance?", the bot emits an `<account_balance_lookup>` tag (mirroring the existing `<member_lookup>` pattern at line ~3 of the chatbot pipeline). The backend intercepts, queries Boulevard for the specific data, injects a one-shot answer into the next system-prompt turn.

**Pros:**
- Zero added latency on first-message lookups (only the members who ask pay the cost)
- No additional data sitting in memory for sessions that never ask
- Easy to scope rollout: ship intercept first, add data slowly per type

**Cons:**
- Adds one Boulevard round trip per question (additive on the existing per-turn latency)
- Bot's first answer about credits is delayed by one round trip
- Stale-by-design across the same session if multiple credit questions are asked

### Option B: Fetch-at-lookup (eager)
**How:** Extend `lookupMember` to pull credits + vouchers + open transactions in parallel with the existing membership + appointment queries. Stash on the profile object; `formatProfileForPrompt` adds a new "Account balances" section.

**Pros:**
- Bot has the answer instantly the first time it is asked
- Single Boulevard round trip per session (the lookup), amortized
- Symmetric with how the existing perk / appointment context is loaded

**Cons:**
- Every session pays the cost even if no balance question is asked (~70 percent of sessions per the QA logs)
- Larger session payload; more PII in memory and in prompt context for sessions that don't need it
- Cache invalidation is harder (if a member buys something mid-session, the cached balance is stale)

### Option C: Hybrid (RECOMMENDED)
**How:**
- At `lookupMember` time, fetch the **summary** (one number per balance type: dollar credit balance, voucher balance, gift card balance) in parallel with the existing membership / appointment queries. Adds one round trip but produces a small payload.
- On detail-level questions ("when does my $50 enhancement credit expire?"), use the on-demand `<account_balance_lookup>` tag to pull the per-credit detail only when needed.

**Why hybrid:**
- Summary is small (3 to 5 scalars) and cheap; covers Decision 7's primary use case (yes/no/range answers about credit balance)
- Detail is queried only when needed (avoiding the per-session PII bloat from Option B)
- Symmetric latency to today's `formatProfileForPrompt` injection; no extra delay on the first credit question

**Recommendation: Option C.** Confirm with Matt before any implementation ticket lands.

---

## 4. PII and safety

Credit balances and transaction history are sensitive. Three constraints:

1. **Outbound block extends to balance details.** No `notify.js` path may surface account balance to email/Slack/SMS recipients other than the member themselves. The cancellation outcome email already routes to memberships@, NOT to the member directly; balance lines must NOT be appended to that email. Add a guard in `notify.js` that strips balance fields from `notify.outcomeEmail` payloads.

2. **`formatProfileForPrompt` injection rules.** The new "Account balances" block in the system prompt MUST be:
   - Behind a flag (`ACCOUNT_DATA_INJECTION_ENABLED`) so it can be killed without a deploy
   - Rounded / coarse-grained for the summary path (e.g., "$25 to $75 in credits", not exact dollar figures) UNTIL Decision 7 is resolved
   - Tagged in the prompt as "do not repeat verbatim unless the member asks specifically", so the bot does not lead retention conversations with "I see you have $200 in credits"
   - **No transaction-level data** in the summary injection. Transactions are detail-only and require the on-demand tag.

3. **Log redaction.** The existing `lookupMember log redaction` test (line 314 of `__tests__/boulevard.test.js`) must be extended to redact the new account-balance fields. A new test covering "outcome email body never contains $-denominated balance lines" should land in PR 1 of the implementation.

---

## 5. Decision 7 tie-in

**Decision 7 (`docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md` line 138)** asks: should the bot be able to see credit details? Options A (wire credit visibility), B (explicit disclaimer + human routing), C (status quo, punt to memberships team).

**This integration is the thing that makes Decision 7 actually matter.** Until credit data is fetchable, Option A is impossible. Option C is current behavior. Option B is a documentation/script change.

The implementation order MUST be:
1. Matt picks A, B, or C for Decision 7 (or explicitly defers Decision 7 pending this build)
2. If Decision 7 is **A**, this build delivers the data layer Decision 7 needs.
3. If Decision 7 is **B**, this build is wasted effort (no credit data is ever surfaced). Do NOT start it.
4. If Decision 7 is **C**, this build is wasted effort. Do NOT start it.

**Action:** Surface this dependency to Matt as part of the plan review. The credit-visibility policy decision must be resolved before or alongside this build.

PR #26 vote B vs Travis vote A is the unresolved conflict noted in commit `872cf7e` ("Phase 8 - surface Decision 7 credit-visibility conflict for Matt to resolve"). The conflict still stands.

---

## 6. Phased ticket breakdown (proposed)

If Decision 7 lands on A, ship in this order. Each ticket is independently shippable per the one-fix-per-PR rule. Tickets named VC- (Visibility of Credits) for tracking.

### VC-1: Boulevard schema probe (read-only)
- Use `getTypeFieldSet` + `getTypeFieldDetailMap` to probe `Client`, `Voucher`, `GiftCardAccount`, `AccountCredit`, `Transaction` types
- Capture the actual schema in `docs/boulevard-account-data-schema_2026-MM-DD.json`
- No production code change; just the probe + the documented schema
- **Gate:** if Boulevard does not expose voucher / gift card / transaction queries the way we assume, this plan needs revision before any subsequent ticket lands

### VC-2: `fetchAccountSummary` helper (data-access only)
- New function in `src/lib/boulevard.js` that takes `clientId` and returns `{ creditBalanceUsd, voucherBalanceUsd, giftCardBalanceUsd, accountBalanceOwedUsd }`
- Uses the introspected schema from VC-1
- Opt-in retry via the Bug 4 retry-transient flag (already in place after fix/boulevard-scan-appointments-query)
- Unit tests with mocked GraphQL responses, including: zero balance, partial data, schema-drift fallback
- **Not wired into lookupMember yet.** Pure data-access layer.

### VC-3: Wire into `lookupMember` and `formatProfileForPrompt`
- Call `fetchAccountSummary` in parallel with the existing membership + appointment queries (matches the Option C hybrid pattern)
- Add an "Account balances" section to `formatProfileForPrompt` output, with the rounding / coarse-grained rule from section 4
- Behind `ACCOUNT_DATA_INJECTION_ENABLED` flag (default OFF)
- Tests: redaction, prompt-injection shape, flag-off baseline

### VC-4: `<account_balance_lookup>` on-demand tag
- New backend intercept in the chat route (mirrors `<member_lookup>`)
- Pulls per-credit detail (type, expiry, original issue date) from Boulevard
- Bot uses for detail-level questions only
- Tests: tag-parsing, fall-through when tag is not emitted, error path when Boulevard is down

### VC-5: Decision 7 rollout (script changes)
- Update `src/lib/system-prompt.txt` per whichever Decision 7 sub-option Matt picked
- Stripping the "I can't see your specific credit balance" punt
- Adding "if the member asks about credits, refer to the Account balances section in the system prompt"
- Test: prompt-text assertion that the punt language is removed and the balances reference is present

### VC-6: Notify guard against balance leakage
- Extend `notify.js` to redact balance fields from outcome emails
- Test: outcome email body never contains $-denominated balance lines, even when injected into the session

### VC-7: Cache invalidation strategy
- Decide: do we cache `fetchAccountSummary` per session, or query fresh on every turn?
- If cached: TTL (5 min default), invalidation on outcome-driven turns (e.g., after a retention offer is accepted)
- If fresh: confirm the latency is acceptable on the per-turn budget (currently ~800ms for membership + appointment fetch)

### VC-8 to VC-11: deferred until VC-1 through VC-7 are live and observed.

### Optional VC-12: Transaction history surface
- Adds the on-demand `<transaction_history_lookup>` tag for "did I get charged for the May session?" questions
- Lowest priority; ship only if the QA log review shows multiple sessions hitting this gap

---

## 7. Test strategy + rollback

### Test strategy
- VC-1: schema probe lands as a doc only; no test
- VC-2: unit tests with mocked GraphQL (mirror the Bug 4 pattern from `__tests__/boulevard.test.js` line 2298)
- VC-3: prompt-injection tests + flag-off baseline + redaction extension
- VC-4: tag-parsing tests + error-path tests
- VC-5: prompt-text assertion (existing pattern in `__tests__/system-prompt-*.test.js`)
- VC-6: notify-body redaction test (new file: `__tests__/notify-balance-redaction.test.js`)
- VC-7: cache-TTL test + invalidation test
- Every PR: full `vitest run` must pass; PR description names the QA_ISSUES.md issue number it addresses

### Rollback
- VC-3 is the first user-visible change. Flip `ACCOUNT_DATA_INJECTION_ENABLED=false` in Vercel and redeploy; the section disappears from the prompt with no other side effects.
- VC-4 has the same flag wrap. Turning the flag off disables the on-demand path.
- VC-5 is a script change; revert via `git revert` of the single commit.
- VC-2 has no user-visible effect alone; revert is harmless.
- VC-1 is doc-only; revert is harmless.

---

## 8. Open questions for Matt

1. **Decision 7 must resolve first.** A, B, or C? See section 5. If B or C, this whole plan is wasted effort.
2. **Coarse vs. exact balances in the prompt.** The hybrid recommendation rounds to a range ("$25 to $75 in credits") in the summary. Is that the right default, or do you want exact figures from day one?
3. **Voucher and gift-card scope.** Are vouchers and gift cards inside scope, or only membership credits? Travis previously said the gift-card system is separate; if so, drop the gift card part of VC-2.
4. **Per-turn vs. per-session balance refresh.** Refresh on every turn (high accuracy, +800ms per turn) or once per session (stale risk if balance changes mid-session)?
5. **Behavioral safety: should the bot ever PROACTIVELY mention a credit balance?** Today's bot leads with retention offers; surfacing "you have $200 in credits" unprompted could anchor the member on the credit value and shift the conversation. Recommend NO proactive mention in any of the VC tickets, only respond when asked. Confirm.
6. **Compliance review.** Credit / transaction visibility may need a separate look from Justin Prochnow (Greenberg Traurig). The bot showing balance is not itself a TCPA issue, but rolling out new account data injection might be worth a 15 minute call before VC-3 ships.

---

## 9. Estimated effort

- VC-1: 1 to 2 hours (probe + doc the schema)
- VC-2: 4 to 6 hours (helper + tests + parallel mock fixtures)
- VC-3: 3 to 4 hours (wire + prompt-injection + tests)
- VC-4: 3 to 4 hours (intercept + tag-parsing + tests)
- VC-5: 1 to 2 hours (script-only PR)
- VC-6: 1 to 2 hours (notify guard + test)
- VC-7: 2 to 3 hours (cache decision + implementation)
- **Total:** 15 to 23 engineering hours, spread across 6 to 7 PRs.

If Decision 7 lands as B or C, the only required work is updating the system prompt (a 1 to 2 hour change covered by VC-5 only).

---

## 10. What this plan does NOT cover

- Mutations on account credits (issuing, expiring, transferring). Pure read-only integration.
- A self-serve "view my account" page outside the cancellation widget. That's a Mirrosa product question, not a sm-member-cancel scope question.
- Klaviyo or Twilio integration for balance notifications. Same reason.
- Multi-currency. Boulevard for Silver Mirror is USD only.
- Refund flows. The bot does not initiate refunds.

---

## 11. Recommended next action

1. Matt reads this plan
2. Matt resolves Decision 7 (A, B, or C) per section 5
3. If A: schedule VC-1 (the schema probe) as the first ticket; everything else waits on its output
4. If B or C: archive this plan, ship only VC-5-equivalent prompt change
