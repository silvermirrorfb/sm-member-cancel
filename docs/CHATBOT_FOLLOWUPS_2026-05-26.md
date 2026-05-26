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
