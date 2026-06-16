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

Three cron jobs are configured in `vercel.json`:

**`/api/cron/sms-registry-seed`** runs `0 10 * * *` (10:00 UTC, around 6 AM ET in summer). Pages through Boulevard `clients` GraphQL API, pulls every guest for each of the 10 locations, writes to Upstash Redis under `sms-registry:loc:{locationId}` with 7-day TTL. Registry size around 4,000 to 4,100 guests total. This workaround exists because Boulevard has no "appointments by location" query. See QA_ISSUES Issue 1 (outbound SMS).

**`/api/cron/sms-upgrade-scan`** runs `*/10 * * * *` (every 10 minutes, all hours) but no-ops outside the send window. Gate order inside the route: (1) `CRON_SECRET` auth, (2) `SMS_CRON_ENABLED` must be truthy or it returns `{ ok: true, skipped: 'SMS_CRON_ENABLED is false' }`, (3) the 9 AM to 7 PM `America/New_York` send window (`SMS_SEND_TIMEZONE` / `SMS_CRON_SEND_START_HOUR` / `SMS_CRON_SEND_END_HOUR`), (4) `SMS_CRON_LOCATIONS` must be non-empty, (5) registry must be populated. Then it Fisher-Yates shuffles the registry, takes `SMS_CRON_BATCH_SIZE` candidates (default 30, not 5 - the docs that say 5 are stale), processes them in parallel sub-batches of 5 with a 5s pause between, and for each candidate calls `/api/sms/automation/pre-appointment` with `dryRun: false`. That downstream endpoint applies fit/gap/skin-profile rules, the Klaviyo subscription check, the `SMS_REQUIRE_MANUAL_LIVE_APPROVAL` gate, and the actual Twilio send.

The response shape is `{ ok, registryCounts, candidateCount, summary: { total, sent, skipped, errors }, results: [ { candidate, status, reason } ] }`. There is no `skippedByReason` histogram - the per-candidate `results[]` is the only breakdown. (The skip-reason histogram was item #2 in the rejected 5-fix bundle, never merged. See QA_ISSUES Issue 7, outbound SMS.) If `summary.sent` is 0 across many in-window runs AND `results[]` doesn't show legitimate skip reasons (Klaviyo not subscribed, no upcoming appointment, cooldown), something is wrong. Before concluding a run "failed," confirm `SMS_CRON_ENABLED` is on, you're inside the 9-to-7 ET window, and `SMS_REQUIRE_MANUAL_LIVE_APPROVAL` is not silently holding sends.

**`/api/cron/missed-call-dispatch-drain`** runs `*/1 * * * *` (every minute), draining the missed-call autotext queue. That workload (Brickell pilot) is still in build, so this is mostly draining an empty queue today.

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

The full list is in `.env.example`. These are the real names as they exist in Vercel production (audited 2026-05-12), grouped by what they do:

Boulevard:
- `BOULEVARD_API_URL` - has `/graphql` baked in, do NOT modify
- `BOULEVARD_API_KEY`, `BOULEVARD_API_SECRET`, `BOULEVARD_BUSINESS_ID` - auth (there is no single `BOULEVARD_API_TOKEN`)
- `BOULEVARD_SERVICE_ID_50MIN`, `BOULEVARD_ENABLE_UPGRADE_MUTATION`, `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` - feature flags

Klaviyo (the TCPA consent gate):
- `KLAVIYO_PRIVATE_API_KEY` (there is no `KLAVIYO_API_KEY`), `KLAVIYO_API_BASE_URL`, `KLAVIYO_REVISION`, `SMS_REQUIRE_KLAVIYO_OPT_IN`

Twilio:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (the var is `_FROM_NUMBER`, value `+18885127546`)

SMS cron controls:
- `SMS_CRON_ENABLED` - master on/off for `sms-upgrade-scan`. If falsy the cron is a no-op.
- `SMS_CRON_LOCATIONS` - comma-separated location IDs the scan targets; empty -> 400
- `SMS_REQUIRE_MANUAL_LIVE_APPROVAL` - downstream send gate; can produce `sent: 0` with no bug
- `SMS_UPGRADE_STATUS`, `SMS_AUTOMATION_TOKEN`, `CRON_SECRET`
- `SMS_CRON_BATCH_SIZE` (not currently set; defaults to 30), `SMS_SEND_TIMEZONE`/`SMS_CRON_SEND_START_HOUR`/`SMS_CRON_SEND_END_HOUR` (not set; default 9-19 America/New_York)

Redis: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

Google Sheets: `GOOGLE_SHEET_ID` (the cancellations sheet; `GOOGLE_CANCELLATIONS_SHEET_ID` does not exist), `GOOGLE_CHATLOG_SHEET_ID` (was the silent-failure in Issue 4, cancel bot - confirmed set), `GOOGLE_SERVICE_ACCOUNT_JSON`

Email / notify (`notify.js`): `EMAIL_TO`, `EMAIL_FROM`, `EMAIL_ESCALATION` (also the recipient for the zero-send ops alert), `EMAIL_REACTION_ALERTS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (there is no `MEMBERSHIPS_NOTIFY_EMAIL`)

SMS monitoring (added 2026-05-12): `SMS_MIN_DAILY_SENDS` (zero-send alert threshold, default 1; the `sms-health-check` cron emails `EMAIL_ESCALATION` if yesterday's send count is below this). The send count lives in Redis at `sms-sent:<YYYY-MM-DD>` (3-day TTL), bumped by `src/lib/sms-metrics.js` on every Twilio send.

Chat widget: `ANTHROPIC_API_KEY`, `ALLOWED_ORIGIN`

Error monitoring: Sentry (`@sentry/nextjs`) is wired (`src/instrumentation.js`, `src/sentry.server.config.js`, `src/sentry.edge.config.js`, `src/instrumentation-client.js`, `next.config.js` `withSentryConfig`) but **inert until a DSN is set**. To activate: create a Sentry project, then `vercel env add SENTRY_DSN production` (server-side; also `preview`/`development`) and optionally `vercel env add NEXT_PUBLIC_SENTRY_DSN production` (browser widget); for source-map upload also add `SENTRY_AUTH_TOKEN` and pass `org`/`project` to `withSentryConfig`. Redeploy after adding env vars (see `MEMORY.md`).

**Production env var audit was last done 2026-05-12.** Any future agent touching `notify.js` or the cron routes should re-verify against `vercel env ls production --scope silver-mirror-projects`. See QA_ISSUES Issue 6 (cancel bot). Note `src/lib/validate-env.js` exists and gives partial env-presence checking; it is not yet wired to fail closed everywhere.

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

## External IDs and references
- Google Sheets logging:
  - Cancellations sheet: `1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg`
  - Chatlogs sheet: `1Wu7th9Z9tO9nQuy7j2FyEgm1YKhDwvgcVPZDprE8z-Y`
- Vercel project: `prj_2eN5VZwqjEZ01m28Zr6PrGj3b8oX`

## Parallel Zapier bot (still live)
- A parallel Zapier bot is STILL ACTIVE on silvermirror.com and handles a significant share of cancellation traffic. Do NOT assume this system handles all cancellation sessions.
- Share as of 2026-04-19 (verify, may have changed): ~48% of sessions.
