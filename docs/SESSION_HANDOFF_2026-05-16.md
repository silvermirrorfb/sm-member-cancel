# Session Handoff — Cancel Bot Two-Day Sprint Complete

**Date:** 2026-05-16
**Author:** Matt (with Claude in this chat as the coordination layer)
**Audience:** Future Claude sessions, other agents (Claude Code, Cursor, Codex, Cowork), Matt picking up later
**Source chat:** `claude.ai/chat/[this-session]`

**Predecessor:** `SESSION_HANDOFF_2026-05-05.md` — covered the April outage diagnosis and the first wave of stash recovery.
**Successor:** This document. State of the codebase as of end-of-day May 16, 2026.

---

## 0. tl;dr — what changed in two days

24+ PRs merged across the `sm-member-cancel` repo. Every Fernanda-flagged production escalation closed at the code layer. Every Travis-decision input implemented. Monitoring layer activated end-to-end so the April 2026 silent 3-week SMS outage scenario is no longer structurally possible.

**If you only read one section, read Section 4** — current state of main and what's open.

---

## 1. Repo state

**Branch:** `main`
**Latest merge commits, newest first:**

- `41db562` — Merge PR #28 (first-offer positive emotional reframing + pricing fix)
- `4486be0` — Merge PR #27 (final escalation cleanup + commitment clarification)
- `fee4ae3` — Merge PR #26 (firm-refusal short-circuit + credit disclaimer)
- `d584235` — Merge PR #25 (billing dispute script)
- `36c01ed` — Merge PR #24 (out-of-footprint relocation)
- `3ee9290` — Merge PR #23 (already-tried-channel auto-escalation)
- ...older PRs from yesterday's stretch and pre-stretch fixes

**Working directory (canonical clone):** `~/sm-member-cancel` on Matt's Mac. Also exists on PC at `C:\Users\tolas\Documents\M-Central\projects\sm-member-cancel`.

**Untracked files in canonical clone:** `AGENTS.md`, `docs/MISSED_CALL_SYSTEM_PROMPT_DRAFT.md`, `docs/SESSION_ACTIVITY_LOG_2026-05-03.md`, `scripts/diag-bv-appointments.mjs`, `scripts/diag-eligible-pool.mjs`. All pre-existing from earlier sessions. Cowork/Claude Code instructed to leave these alone.

**Branches not deleted (left intact for reference):** `fix/already-tried-channel-auto-escalation`, `fix/relocation-out-of-footprint-no-retention`, `fix/billing-dispute-escalation-script`, `fix/retention-softening-and-credit-disclaimer`, `fix/escalation-cleanup-and-commitment-clarification`, `feat/first-offer-positive-emotional-reframing`. Plus older yesterday-branches.

---

## 2. What shipped in this two-day stretch

### Yesterday (May 15) — Track 1, 2, 3 work + first production escalations

**SMS outbound restoration (Track 1):**
- PR #9 — Cron rewired from random-sampling to per-location appointment discovery. Real root cause of the April 14 to May 5 outage (not the Boulevard `client { ... }` selection bug PR #3 fixed, though PR #3 was a legitimate latent fix). Verified live the same day: 2 real texts sent with zero errors.

**Monitoring layer (Track 2):**
- PR #10 — `src/lib/sms-metrics.js` daily counter in Redis (key pattern `sms-sent:<YYYY-MM-DD>`, 3-day TTL, ET timezone)
- PR #11 — Daily zero-send alert cron at `/api/cron/sms-health-check` (`0 14 * * *` ≈ 9-10 AM ET, emails `EMAIL_ESCALATION` if yesterday's sends are below `SMS_MIN_DAILY_SENDS` threshold)
- PR #12 — Sentry wired (`@sentry/nextjs` SDK across server, edge, client config; gated by `Boolean(dsn)`)
- PR #13 — Cancel-bot HARD RULE banning fabricated escalation language

**Cancel-bot template routing (Track 3):**
- PR #14 — Regex word boundaries on template reason matchers (fixed adjacent "transitions" matching "transit" vulnerability from PR #8)
- PR #15 — SMS resolves candidates by `clientId` (eliminates `member_not_found` for indexed members)
- PR #16 — Per-subsystem env validation, fails loud at boot
- PR #17 — Conversation eval scaffold + `docs/STAGING.md`

**Production escalations from Fernanda:**
- PR #18 — Travis-decision system prompt broadening. Covers Zoe Dickinson (missing milestone rewards) AND Sindhura Polepalli (credits disappeared during pause). Three edits: constrain milestone discussion to upcoming only, new HARD RULE for "no defined process" handoffs, strengthen PR #13 no-fabricated-escalation rule with Sindhura-class soft-promise examples.
- PR #19 — REFERRED routing verification. No code change. Confirmed PR #8 was live in production via three independent signals (code, tests, deploy timestamp). Sindhura's pre-PR-#8 session was not a regression.
- PR #20 — Travel + bi-monthly template routing. Rose Williamson case. Root cause: detector ordering inside RETAINED block fired `isPause` before `isBimonthly` when the accepted-offer string contained both words. Fix: reorder most-specific first.
- PR #21 — Placeholder string bleed. Sindhura email body fix. Added `isPlaceholderValue` / `safeFieldValue` / `creditsParen` helpers. Refined regex to nested-paren detection only (preserves legitimate qualifiers like "$95 (30-min)").
- PR #22 — Server-side date stamping. Bot was hallucinating dates (Zoe May 7 logged as 2024-12-19, Sindhura May 10 as 2025-01-27). Three-layer fix: removed from prompt schema, server-side stamp, defense-in-depth fallback.

### Today (May 16) — Travis-decision implementation + customer suggestion

- PR #23 — Already-tried-channel auto-escalation (Decision 4). Email GOOD example revised to add warmth.
- PR #24 — Out-of-footprint relocation (Decision 5). Congo GOOD example revised to strip "48 hours" and "30 days" timeline promises (PR #18 violations).
- PR #25 — Billing dispute script (Decision 7). Acknowledges seriously, asks for dates of disputed charges, uses PR #18 standard handoff phrase, no SLA promises.
- PR #26 — Firm-refusal short-circuit (Decision 1) + Credit visibility disclaimer (Decision 8). Christina GOOD example revised to strip timeline promises. Cross-reference sentence added to rule body.
- PR #27 — Final escalation cleanup sweep (Decision 2) + commitment language clarification (Decision 10). **11 instances** of timeline-promise drift cleaned from across the prompt. Internal contradiction fixed: FIRM REFUSAL ban list now explicitly allows the 30-day legal notice and 90-day credit policy.
- PR #28 — First-offer positive emotional reframing (customer suggestion from Fernanda's May 4 forward, Travis approved). Pricing example corrected: `$109` was untethered to any real rate; replaced with `{{MEMBER_30}}` template variable (resolves to $99 at runtime per `CURRENT_RATES['30']`).

**Sentry DSN activated end-of-day May 16.** Code was wired in PR #12 yesterday but inert until DSN was set. Activated today via `vercel env add SENTRY_DSN` across production/preview/development (both `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`). Production redeploy completed. Sentry project on dashboard: `sm-member-cancel-nz`.

---

## 3. Production cases now closed at the code layer

Each of these was a real member who received broken behavior. Each has a regression test on its respective PR.

| Member | Date | Class of bug | Closed by |
|---|---|---|---|
| Emily Merghart | May 4 2026 | RETAINED + Inconsistent Usage + pause accepted → wrong template | PR #4 |
| Nicole | April 16 | Pause-disclosure bait-and-switch | PR #6 |
| Vanessa | April 17 | Pause-disclosure bait-and-switch | PR #6 |
| Zoe Dickinson | May 7 | REFERRED with milestone history → cancellation template | PR #8 + PR #18 (script side) |
| Christina (session d60c370e) | May 1 | Bot pushed retention past two firm refusals | PR #26 |
| Sindhura Polepalli | May 10 | REFERRED with credit display issue → cancellation template + body bleed + 24-48 hour promise | PR #18 + PR #21 + PR #22 |
| Rose Williamson | May 6 | Travel + bi-monthly accepted → travel-pause template, no bi-monthly mention | PR #20 |
| "Congo case" (anonymized) | May 4 | Bot offered 4 retention paths to a member moving internationally | PR #24 |

---

## 4. What's open

### High-leverage, awaiting input from others

**Katie input needed:**
- Decision 6 — Perk dollar values ($65 moisturizer, $77 serum, $41 cleanser, $183 bundle, etc.). Unclear which are accurate, hardcoded, or model-fabricated. Decision options in `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md`.
- Decision 9 — Voice and tone cleanup ("Perfect!" overuse, empathy phrase stacking, salesy benefits list during cancellation).

**Kristen input on:**
- Decision 7 language refinement. PR #25's billing dispute script is in production. Kristen may want to refine wording.

**Travis already returned votes:** Decisions 1, 4, 5, 7 received. Decisions 3 (kept name + email, his read), and Decisions 2, 8, 10 (Matt votes accepted by Travis as MM-call).

### Provisioning/infrastructure decisions

- **Staging Vercel project** — billable infra decision. Not unilateral. Park until you want to think about it. Argument for: closes the "no test environment" structural gap. Argument against: tight scope-locked PRs in production have been working.
- **Sentry SDK upgrade + `disableLogger` cleanup** — minor. Do on next Sentry SDK version bump. Not urgent.

### Verification work (passive)

- **Sparse Sheet rows verification.** PR #22 fixed the date hallucination that was causing date-filtered Cancellations Sheet queries to return near-empty results. Worth checking a few days from now whether row counts on May 17+ match the ~31/day baseline from `CLAUDE.md`. If counts are still sparse post-PR-#22, that's a separate sheet-write health issue worth digging into.
- **Sentry dashboard.** Check `sm-member-cancel-nz` project on sentry.io periodically. If errors appear, investigate. If no errors appear after 48 hours, that's a good sign — code paths the bot hits are exception-clean.
- **Daily zero-send alert.** Watch your inbox for the 9-10 AM ET alert from `EMAIL_ESCALATION`. If it fires, investigate immediately (means outbound SMS dropped below `SMS_MIN_DAILY_SENDS` threshold).

### Noted observations, not filed

- **Bryant Park ~36% `member_not_found` rate.** Walk-ins and new clients booking through Boulevard before they've been seeded into our member registry. Expected behavior. Worth investigating only if you want to increase outbound SMS reach. Not a bug.
- **6 reason × accepted-offer routing gaps surfaced by PR #20.** All produce "acceptable defaults" (generic copy that's not wrong, just generic). None cause hand-rewrites for Fernanda the way Rose's case did. Revisit if Fernanda flags any.
- **The five-fix bundle from May 5.** Stashed in archive clone `~/sm-member-cancel-archive` (or `C:\Users\tolas\Code\silvermirrorfb\sm-member-cancel` on PC). Three of the five were superseded by today's work (PR #9 replaced cron rewrite, PR #15 replaced member tier resolution, PR #11 effectively replaced skip-reason histogram). Two remaining (addon rotation, Redis cooldown rewrite) could be individually evaluated but aren't currently blocking anything.

---

## 5. Architectural patterns learned

These accumulated across the session. Worth knowing for future work.

**System prompt drift is real.** The training data (real member transcripts) contains pattern-matched phrases that keep regenerating into new examples. We caught the same "48 hours" / "30 days" timeline-promise leak three times (PR #24 Congo, PR #26 Christina) before doing the comprehensive sweep in PR #27, which found **11 more** instances accumulated across the prompt. Lesson: every system prompt PR should explicitly check that its examples are compliant with all prior HARD RULES, not just the new one being added. The PR #27 cross-reference sentence pattern (e.g., "Confirmation language must comply with PR #18: no specific resolution timelines...") is a small structural defense that should be replicated in any future HARD RULE that involves member-facing language.

**Parallel agents work when the QA_ISSUES.md ledger is healthy.** Today and yesterday, Claude Code, Cursor (via Cowork), Codex, and this chat all touched the same codebase across 24+ PRs without scope-creep incidents, conflicting commits, or rejected bundles. The pattern that made this work: (1) QA_ISSUES.md as canonical state-of-truth, updated on every PR, (2) tight scope-lock language in every PR prompt, (3) reviews before merge with explicit quote-back of new GOOD examples and rule language, (4) one PR per concern, no bundles. When this drifts, expect the bundle-and-creep problems documented in the May 5 handoff.

**Template variable injection is real and works.** `{{MEMBER_30}}`, `{{MEMBER_50}}`, `{{MEMBER_90}}` are injected at runtime in `src/lib/claude.js` line 21 via `.replaceAll()`. Current canonical rates from `CURRENT_RATES` in `src/lib/boulevard.js` line 218: 30-min = $99, 50-min = $139, 90-min = $199. **Use these variables in any new GOOD examples that reference monthly tier pricing.** Hardcoded numbers will go stale and produce wrong-price quotes to members.

**The Cancellations Google Sheet (`1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg`) is canonical.** Sessions log here. As of PR #22, date columns should now be server-stamped accurate. Use this sheet (filtered by date) for ground-truth verification of any production behavior question.

**`docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md` is the decisions ledger.** Travis answers go in here. Matt votes go in here. Currently has 10 decisions, 7 implemented (PRs #18, #23, #24, #25, #26, #27), 3 awaiting non-Matt input (Decisions 6, 7 refinement, 9).

---

## 6. The 10-decision document — current state

| Decision | Owner | Status |
|---|---|---|
| 1 — Retention aggressiveness | Matt (Travis deferred to MM) | ✅ Implemented in PR #26 (vote B) |
| 2 — Strip fabricated escalation | Matt | ✅ Implemented in PR #27 (vote A, sweep found 11 instances) |
| 3 — Identity verification floor | Travis | ✅ Decision 3A: keep name + email (Travis read) |
| 4 — Already-tried-channel | Travis | ✅ Implemented in PR #23 (vote A) |
| 5 — Out-of-footprint relocation | Travis | ✅ Implemented in PR #24 (Approve) |
| 6 — Perk dollar values | Katie | 🟡 Open, awaiting Katie |
| 7 — Billing dispute script | Travis + Kristen | ✅ Implemented in PR #25 (Travis Approve, Kristen may refine) |
| 8 — Credit visibility | Matt | ✅ Implemented in PR #26 (vote B) |
| 9 — Voice and tone | Katie | 🟡 Open, awaiting Katie |
| 10 — Commitment clarification | Matt | ✅ Implemented in PR #27 (Approve) |

**Plus customer suggestion (out-of-doc):** Positive emotional reframing in first retention offer. Approved by Travis. Implemented in PR #28.

---

## 7. Repos and tools

- **Repo:** `silvermirrorfb/sm-member-cancel`
- **Vercel project:** `prj_2eN5VZwqjEZ01m28Zr6PrGj3b8oX` (team `team_1T7EbCxgdUyvGSWaVHPEk2Ym`)
- **Sentry project:** `sm-member-cancel-nz` on sentry.io
- **Cancellations Sheet:** `1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg`
- **Chatlog Sheet:** `1Wu7th9Z9tO9nQuy7j2FyEgm1YKhDwvgcVPZDprE8z-Y`
- **Production URL:** `https://sm-member-cancel.vercel.app`
- **Twilio number (outbound SMS):** `+18885127546`
- **Klaviyo SMS consent gate:** `SUBSCRIBED` status required (TCPA compliance)

**Key files in `src/lib/`:**
- `system-prompt.txt` — the bot's brain. Has 10+ HARD RULES added across this session. **Do not edit this file casually.** Every change needs a regression test and a cross-check against prior HARD RULES.
- `member-draft.js` — email template selection and interpolation. Has `isPlaceholderValue` / `creditsParen` helpers (PR #21).
- `notify.js` — email + sheet logging. Has `safeIsoDate` helper (PR #22) and `sendOpsAlertEmail` (PR #11).
- `boulevard.js` — Boulevard GraphQL client. Has `CURRENT_RATES` constant (line 218).
- `claude.js` — Claude API wrapper. Has `buildSystemPrompt` (line 21) that does runtime template variable substitution.
- `sms-metrics.js` — daily SMS send counter (PR #10).
- `sms-cron-scan.js` / cron route — per-location appointment discovery (PR #9).
- `boulevard.js` — also has `appointment.client { ... }` fix (PR #3, latent bug, was masked by PR #9's bigger fix).

**Environment variables now set in Vercel:**
- `SENTRY_DSN` (all 3 environments) — newly activated end-of-day May 16
- `NEXT_PUBLIC_SENTRY_DSN` (all 3 environments) — same
- `EMAIL_ESCALATION` — receives daily zero-send alerts
- `SMS_MIN_DAILY_SENDS` — threshold for zero-send alert (default 1, should be tuned up after baseline data)
- All the canonical SMS, Boulevard, Klaviyo, Twilio, Google Sheets env vars (unchanged)

---

## 8. Recommended next steps for whoever picks up

**If Matt is picking up tomorrow or next week:**
1. Check the Sentry dashboard. If errors are appearing, investigate.
2. Check the daily zero-send alert email. If it fired, investigate.
3. Check the Cancellations Google Sheet for May 17+ rows. Confirm row count is in the ~31/day baseline range and dates are accurate post-PR-#22.
4. Follow up with Katie on Decisions 6 and 9.
5. Follow up with Kristen on Decision 7 language refinement if she wants tweaks to PR #25.
6. Consider whether to push Decision 6 (perk dollar values) as a discrete fix even without Katie's input — the current values may be wrong but the bot is now less reliant on them after PR #18 stopped reciting them.

**If a different Claude session is picking up:**
1. Read this doc first.
2. Read `docs/CHATBOT_SCRIPT_DECISIONS_2026-05-05.md` for context on the 10-decision tree.
3. Read `QA_ISSUES.md` for the per-issue ledger.
4. If asked to edit `src/lib/system-prompt.txt`, do the cross-reference check against all prior HARD RULES BEFORE writing new examples. The pattern: search the prompt for any prior HARD RULE that uses BAD/GOOD examples, list them, then write the new rule's examples to comply with all of them.
5. Use Cowork to delegate to Claude Code in `~/sm-member-cancel`. Don't have Claude in chat do repo work directly — use the agent stack.

**If Cowork or Claude Code is picking up alone:**
1. Read `CLAUDE.md` at repo root first.
2. Read `QA_ISSUES.md` for the canonical state-of-truth.
3. Don't start any architectural work without explicit Matt approval. The bundle-and-creep pattern is documented in the older `SESSION_HANDOFF_2026-05-05.md` and the current session has held strict scope discipline that should not be broken.

---

## 9. Things to be glad about

Closed a 3-week silent SMS outage and made it structurally impossible to recur. Cleared every Fernanda escalation from the memberships team queue. Implemented every Travis ops decision. Made the bot honest about what it can and can't promise. Caught a $10/month pricing leak before it could compound across members. Built a monitoring layer that will outlive any single conversation.

Two days of strict scope discipline. 24+ PRs. Zero rejected bundles. Zero scope creep. Zero production regressions.

The handoff is clean.
