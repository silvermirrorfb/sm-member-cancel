# Chatbot Follow-Ups from Week of 2026-05-20 Log Review

Issues identified in the General Chatbot log review on 2026-05-26 that are
out of scope for the same-day system-prompt fix and need their own plans.

## Status legend

- **RESOLVED** — shipped on main; PR linked
- **DEFERRED** — explicitly deferred by Matt; needs its own plan later
- **OPEN** — still on the backlog

---

## 1. Booking error telemetry (6 sessions) — RESOLVED

**Resolved 2026-05-26** in PR
`fix/chatbot-promo-copy-and-booking-error-telemetry` (pending ship as of
this writing; update with merge commit SHA on merge).

**Original priority rationale:** Six distinct sessions this week hit real
production bugs ("why can't I book", "promo code invalid", "card keeps
getting rejected", "wrong number", "unconfirmed at the top of the forms",
"promo code says invalid"). Bot routed every one of them to
(888) 677-0055 or hello@silvermirror.com. Engineering had zero signal.

**Sessions:** e1511782 (2026-05-21), f668a8d1 (2026-05-22), d7167eb3
(2026-05-22), 75cff478 (2026-05-22), 14c51ad6 (2026-05-25), and the
booking-related portion of others.

**What shipped:**

- New module `src/lib/booking-error-telemetry.js` classifies inbound user
  messages against six symptom categories: `promo_code`, `referral_code`,
  `card_payment`, `cant_book`, `wrong_phone_number`, `site_down`.
  Detection is regex-based (deterministic, fast, no extra LLM call) with
  an address-context suppressor on `wrong_phone_number`.
- On a hit, fires a Sentry `warning` event named
  `chatbot.booking_error_detected` with tags `{ category: "booking_error",
  subcategory: <class> }` and extras `{ session_id, user_message,
  bot_response, location?, timestamp }`.
- Rate-limited via Upstash Redis: 1 event per session per subcategory per
  hour (key prefix `chatbot-booking-error-fired:<sid>:<sub>`, 1h TTL).
  Fail-open if Redis is unconfigured or throws — telemetry must not break
  the chat handler.
- PII scrubbing: phones and emails redacted from `user_message` and
  `bot_response` before they hit Sentry. Name fields are simply not
  included in the event payload (session_id alone is enough for engineers
  to correlate to the chat transcript in the Cancellations Google Sheet).
- Wired into `src/app/api/chat/message/route.js`. Detection runs once on
  the sanitized user message; the event fires (fire-and-forget) just
  before the main response return so `bot_response` is available. User-
  facing behavior unchanged — the firing is silent.
- 25 unit tests in `__tests__/booking-error-telemetry.test.js` cover all
  six symptom categories, the address-context suppressor, rate-limit
  behavior, PII scrubbing, and graceful-degrade when Redis is missing.

## 2. Promo / discount awareness gap (3+ sessions) — RESOLVED

**Resolved 2026-05-26** in PR
`fix/chatbot-promo-copy-and-booking-error-telemetry` (same PR).

**Matt's decision (2026-05-26):** softer copy, no data feed. No env var,
no Klaviyo/Boulevard integration. The bot admits limitation politely and
routes to the website / hello@.

**Original symptom:** Users ask "$20 off code", "when is the 40 off",
"is there a first-time discount?" Bot used to redirect specific-promo
questions to a generic membership pitch (lines 386 of the old prompt),
which guests read as dismissive.

**Sessions:** 150625ca (2026-05-21), 69fd282f (2026-05-21), a2f989c9
(2026-05-24).

**What shipped:**

- New polite-limitation response in `src/lib/system-prompt.txt`
  PROMOTIONS POLICY section: "I'm sorry, I don't have information related
  to possible promotions. You can check our website at silvermirror.com
  or email us at hello@silvermirror.com for current offers."
- New HARD RULE: `NO FABRICATED PROMO CODES OR DISCOUNTS`. Forbids the
  bot from inventing codes, quoting discount percentages, or naming
  promos. Also forbids redirecting a specific-promo question to a
  generic membership pitch (the dismissive behavior we are fixing).
- The pre-existing membership pitch is preserved but scoped to guests
  asking general "how do I save money" / "what's the best value"
  questions, not specific-promo questions.
- The pre-existing "promo code isn't working at checkout" response is
  preserved (it's the right answer for guests who already have a code).
- Regression test in `__tests__/system-prompt-promo-policy.test.js` (4
  assertions): polite-limitation present, HARD RULE present, no
  fabrication-licensing language, no dismissive redirect.

## 3. Account / credits / vouchers integration gap (4+ sessions) — DEFERRED

**Deferred 2026-05-26 by Matt.** Needs its own dedicated plan after the
Step 0.5 SMS-webhook PR ships. Not bundled with this work.

**Symptom:** Bot can read membership tier (Boulevard integration exists
for that) but says "I don't have visibility into your specific credit
balance" / "expired vouchers" / "account history". User must wait for a
human follow-up.

**Sessions:** 44e0f0e9 (2026-05-21), b46bc078 (2026-05-24), 0b05614b
(2026-05-25), and the cancel flow in general.

**Next step:** Schedule a dedicated brainstorm + plan after Step 0.5
ships. Boulevard account-data fetch (credits, vouchers, transaction
history) into the chat context. Several days of work.

## 4. Cancel save-flow authority audit (1 session) — RESOLVED (no action)

**Resolved 2026-05-26 by Matt's decision: no action needed.** The $50
add-on offer (Custom Jelly Mask) is authorized as a save attempt. The
bot's behavior in session 0b05614b is within policy.

**Original symptom:** Session 0b05614b (2026-05-25, Angela Li / Flatiron
50-min). User said "too salesy" as cancel reason. Bot offered a
complimentary Custom Jelly Mask ($50 value) add-on as a save attempt.
User accepted, kept membership. Matt confirmed this is authorized.

## 5. False positives discarded

For the record, these flagged in the analysis but are NOT bugs:

- "undefined/null/NaN" matches (19 hits) were all false positives from
  the regex over substrings ("skin maintenance", "pregnancy-safe", etc.).
- "Medical language" matches (40 hits) were almost all the word
  "treatment" used in a cosmetic context, which is allowed.
- Cancel-rebook regression (1 hit, session a4623d4b) was already fixed
  by commit 2937307 before this log window.
