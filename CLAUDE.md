# CLAUDE.md - sm-member-cancel

**Inherits from:** M-Central master `CLAUDE.md` at the M-Central root. Anything in the master applies here unless explicitly overridden below. This file adds project-specific context for any AI agent (Claude Chat, Claude Code, Cursor, Codex) working in this repo.

**Last updated:** May 12, 2026
**Companion doc:** `QA_ISSUES.md` (canonical issue ledger, read it before opening any PR)

---

## What this repo is

A Next.js 14 (App Router) application that runs SIX customer-facing SMS and chat workloads for Silver Mirror Facial Bar. It is the most production-mature codebase in the M-Central ecosystem.

The six workloads share infrastructure but are functionally independent:

1. **Cancellation chatbot (web widget)** - Claude-powered chat embedded on `silvermirror.com/memberships/cancel`. Most mature piece. Roughly 660 sessions per 3-week window.
2. **Pre-appointment add-on upsells** - outbound SMS, just came out of a 3-week outage May 5
3. **Pre-appointment duration upgrades** - outbound SMS, same outage
4. **YES/NO appointment confirmations** - Klaviyo-driven, stable
5. **1-hour appointment reminders** - stable
6. **Missed-call autotext (Brickell pilot)** - IN BUILD, not yet live

When a doc, ticket, or PR refers to "outbound SMS" without further qualification, it means workloads 2 and 3. When it refers to "the bot" or "the chatbot," it means workload 1.

---

## Stack

- **Next.js 14** App Router, deployed to **Vercel** under the `silver-mirror-projects` team
- **Claude Sonnet API** for the cancellation widget conversation
- **Boulevard Enterprise GraphQL API** for member and appointment lookups
- **Klaviyo API** for SMS subscription status (the legal consent gate)
- **Twilio** for SMS send and receive, single number `+18885127546`
- **Upstash Redis** for the daily client registry and rate limiting
- **Nodemailer** for outbound email (memberships@, hello@, kristen@, matt@, rachael@ routing)
- **Google Sheets API** for the Cancellations Sheet and the Chatlog Sheet
- **Vitest** for tests (244 tests as of May 12, mostly covering email template selection)

---

## Hard rules that override everything

These supersede convenience, parallel-agent suggestions, and any out-of-context refactor.

### Identity rules

- **10 locations** (UWS Broadway opened Nov 2025). Never say 9. Never say 11.
- **Hydradermabrasion** is the term. Never HydraFacial (discontinued).
- **Facial bar.** Never med-spa, never spa, never medical anything.
- **Cosmetic-only language.** No treatment claims, no diagnosis claims, no medical language anywhere in bot output.
- **Esthetician's Choice = 50 minutes.**
- **No em dashes anywhere.** Not in code comments, not in bot output, not in user-facing copy, not in PR descriptions. Use commas, semicolons, or sentence breaks.

### Send rules

- **No auto-send of any kind without explicit human gating** except for two carve-outs: (a) the cancellation widget's outcome notifications which the member implicitly triggered by completing the session, and (b) the planned missed-call autotext on initiated phone contact.
- **Twilio outbound for Silver Mirror is `+18885127546` only.** Do not introduce a second sending number. Voice numbers per location are voice-only.
- **Klaviyo SMS subscription status must be `SUBSCRIBED` at send time** for every guest, every workload, no exceptions. This is the TCPA compliance gate. Per-profile check, not segment check (segments have been unreliable, see QA_ISSUES Issue 5).
- **STOP, HELP, START handling** must be honored on every send.
- **Cooldown windows** must be enforced per guest per workload.

### Code rules

- **Drizzle ORM is forbidden** on Vercel.
- **Do NOT modify `BOULEVARD_API_URL`.** It is correctly set with `/graphql` already in the path. Code must NOT append `/graphql`. This bug has been fixed once already, any future "fix" that touches the URL will break production. See QA_ISSUES Issue 2 (outbound SMS).
- **Boulevard appointment queries must request BOTH `clientId` scalar AND the `client` object.** Not one-or-the-other. The introspection-based selector must use additive `if` statements, never `else if`. See QA_ISSUES Issue 6 (outbound SMS), the bug that caused the 3-week outage.
- **Voyage AI embeddings are 1024-dim** (voyage-3-large), never 1536. Not currently used in this repo but the rule is global.

### Scope-lock for PRs

This is the rule that exists because parallel agents have repeatedly tried to bundle architectural rewrites with bug fixes.

- **One fix per PR.** If a PR description contains the word "and" between two architectural changes, split it.
- **No piggyback refactors.** A bug fix PR does not get to also reorganize the cron architecture, swap in-memory state for Redis, or rewrite candidate selection. Those are separate PRs that get separate approval.
- **Verification before next change.** When a PR ships a fix for a production outage, that PR must be verified working in production BEFORE the next PR touching the same surface area lands. The 5-fix bundle attempt on May 5 (Issue 7, outbound SMS) is the cautionary example.
- **No silent no-ops.** If an env var is missing, the system should fail loudly. The current silent no-op pattern is a recurring root cause and any new integration should refuse to load without its required env vars.

---

## Legal framework (do not ignore in any retention or send decision)

- **New York Auto-Renewal Law** requires clear disclosure of all commitment periods BEFORE the member accepts any offer. This is why the pause-disclosure rule says the 3-billing-cycle commitment must appear in the SAME message as the offer, not after acceptance. See QA_ISSUES Issue 7 (cancel bot).
- **FTC Negative Option Rule** prohibits creating barriers to cancellation. "Just cancel" must always work. Final-warning loss framing is allowed at most once. Two clear refusals is the ceiling. See QA_ISSUES Issue 5 (cancel bot).
- **Equinox $600,000 settlement (June 2025)** is the closest recent precedent. NY premium wellness is under closer scrutiny. Retention aggressiveness is a legal exposure, not just a UX preference.
- **TCPA** is enforced via the Klaviyo subscription gate. Do not bypass.

When in doubt on a retention or compliance call, the routing is: Matt decides. Justin Prochnow (Greenberg Traurig regulatory) is consulted when Matt elects to. Not the other way around.

---

## Architecture summary

### Outbound SMS pipeline

Two cron jobs cooperate:

**`/api/cron/sms-registry-seed`** runs daily at 6 AM ET. Pages through Boulevard `clients` GraphQL API, pulls every guest for each of the 10 locations, writes to Upstash Redis under `sms-registry:loc:{locationId}` with 7-day TTL. Registry size around 4,000 to 4,100 guests total. This workaround exists because Boulevard has no "appointments by location" query. See QA_ISSUES Issue 1 (outbound SMS).

**`/api/cron/sms-upgrade-scan`** runs every 10 minutes during business hours. Fisher-Yates shuffles the registry, picks 5 candidates (5, not 50, not 10, due to Vercel timeout constraints, see Issue 3), calls Boulevard per candidate for upcoming appointments, applies fit and gap and skin-profile rules, hits Klaviyo for subscription status, sends via Twilio if all gates pass, logs to Google Sheet. Current daily coverage of the registry is around 7.5%.

A healthy response shape is documented at the bottom of `docs/outbound-sms-system-and-issues.md`. If `summary.sent` is 0 across many consecutive runs AND `summary.skippedByReason` doesn't show meaningful filtering, something is wrong.

### Cancellation widget pipeline

Iframe-embedded chat on the WordPress cancel page. Conversation flow:

1. **General Mode** for any Silver Mirror question
2. **Membership Mode** triggered by membership-related keywords, asks for name and email conversationally
3. Bot emits internal `<member_lookup>` tag, backend intercepts (member never sees), hits Boulevard, injects profile into system prompt
4. **Retention decision tree** with around 20 cancellation reasons, three tiers of save offers (zero-cost first, then low-cost, then high-cost), honor "just cancel" rule
5. **Outcome** captured as one of: RETAINED, CANCELLED, REFERRED, MANAGER_CALLBACK
6. **Notifications fire in parallel** on session end: email to memberships@ (CCs based on sentiment and skin reactions), Google Sheets log, reason-category alert email
7. **Memberships team executes** the actual Boulevard cancellation manually. The bot does not cancel anything.

Email template selection MUST key off outcome first, with reason-based templates only firing as a fallback for RETAINED with no save offer accepted. PR #4 fixed this for RETAINED, PR #8 fixed it for REFERRED. The substring-matching vulnerability that caused the Zoe Dickinson case still exists for RETAINED and CANCELLED reason fallbacks; tightly-scoped PR pending. See QA_ISSUES Issues 8 and 9 (cancel bot).

### Notifications (`src/lib/notify.js`)

The functions in here either fire real notifications OR silently no-op based on env var presence. This silent-no-op behavior is the root cause of Issue 6 (cancel bot), where the bot promises things the system isn't actually doing. Treat every claim in bot output as a contract: if the bot says "I've alerted X," there must be code that actually alerts X, and that code must fail loudly if not configured.

---

## Where things live

```
sm-member-cancel/
  src/
    app/
      api/
        chat/                 widget conversation routes
        cron/
          sms-registry-seed/  daily Boulevard pull, writes Redis
          sms-upgrade-scan/   10-min candidate scan and send
      memberships/cancel/     widget UI (iframe target)
    lib/
      boulevard.js            GraphQL client, BOTH-field selector
      klaviyo.js              per-profile subscription check
      notify.js               email + Sheets + category alerts
      retention.js            decision tree, save offers
      templates/              email templates by outcome
      pricing.js              centralized current pricing (bi-monthly tier)
  docs/                       28 docs folders/files
    outbound-sms-system-and-issues.md
    cancel-bot-system-and-issues.md
    CHATBOT_SCRIPT_DECISIONS_2026-05-05.md  the 10 decisions for Travis
  __tests__/                  Vitest suite, 244 tests
  scripts/                    one-off utility scripts
  .env.example                full required env var list
  README.md
  UPGRADE_SYSTEM_SUMMARY.md
  CLAUDE.md                   THIS FILE
  QA_ISSUES.md                canonical issue ledger
```

---

## Environment variables that matter

The full list is in `.env.example`. The ones that have caused production issues:

- `BOULEVARD_API_URL` - has `/graphql` baked in, do not modify
- `BOULEVARD_API_TOKEN` - required for everything
- `KLAVIYO_API_KEY` - required for the SMS consent gate
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` - `+18885127546`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `GOOGLE_CHATLOG_SHEET_ID` - was the silent-failure in Issue 4 (cancel bot)
- `GOOGLE_CANCELLATIONS_SHEET_ID` - `1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg`
- `ANTHROPIC_API_KEY` - for the widget conversation
- `MEMBERSHIPS_NOTIFY_EMAIL` - memberships@silvermirror.com
- `SENTRY_DSN` or equivalent - not currently set, should be

**Production env var audit is overdue.** Any future agent touching `notify.js` should verify the production env at the same time. See QA_ISSUES Issue 6 (cancel bot).

---

## Parallel-agent coordination rules

This codebase has been touched by Claude Code, Cursor, and Codex in parallel sessions. Roughly half of the regressions in `QA_ISSUES.md` trace to uncoordinated changes.

The non-negotiable rules:

1. **Read `QA_ISSUES.md` before opening any PR.** If your fix touches an issue listed as resolved, you risk regressing it.
2. **One fix per PR. No bundles.** Even if you found three things wrong.
3. **PR descriptions name the issue number** from `QA_ISSUES.md` they address.
4. **Verification gates the next PR.** If your fix is for an outage, the next PR on the same surface area waits for verification.
5. **Branches stash, not merge, when in doubt.** The 5-fix bundle is preserved in an archive clone, never committed to main. Same pattern for any future speculative bundle.
6. **Tahir Montgomery is not the escalation path** for this repo. He owns Mirrosa backend. This codebase is AI-only tooling per M-Central master.

---

## Tone and copy rules for bot output

These apply to the cancellation widget specifically and to any future natural-language output added to the SMS workloads.

- No em dashes (this is global, restating because it matters here too).
- Avoid "Perfect!" as a default acknowledgement. It reads weird in neutral or unresolved moments.
- No stacked empathy phrases. "I hear you," "No worries," "That makes sense," "I understand" should not appear two or three times in adjacent messages.
- If a member says they've already tried email or phone, the bot does NOT send them back to that channel. Escalate directly.
- Disclose all commitments BEFORE acceptance, in the same message as the offer.
- Honor "just cancel" after one or at most two clear refusals.
- "I've alerted the QA team" and similar fabricated escalation promises must be stripped from the prompt unless the underlying system exists.

---

## What I am as an AI agent in this repo

I am not the owner of decisions about retention aggressiveness, identity verification floors, or which dollar values to lock in for perks. Those are Matt's calls, and currently sit with Travis as Decisions 1 through 10 in `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`.

I am responsible for:

- Faithful execution of decided scope
- Surfacing inconsistencies and risks
- One-fix-per-PR discipline
- Reading `QA_ISSUES.md` before touching anything
- Updating `QA_ISSUES.md` when shipping or surfacing issues
- Never auto-sending, never bypassing the Klaviyo gate, never violating the legal framework above

When uncertain, the answer is: stop, surface the question to Matt, wait.

---

## Pointers

- Issue ledger: `QA_ISSUES.md`
- Outbound SMS deep dive: `docs/outbound-sms-system-and-issues.md`
- Cancel bot deep dive: `docs/cancel-bot-system-and-issues.md`
- Travis decisions: `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`
- M-Central master: `~/Documents/M-Central/CLAUDE.md`
