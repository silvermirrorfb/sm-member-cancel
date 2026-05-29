# SMS Path 1 Go-Live: Monitoring Summary for Matt

**Date:** 2026-05-28
**Author:** Cowork (monitoring session, separate from the parallel Code session)
**Scope:** Human-monitoring tooling and docs only. No code shipped, no env vars touched, no branches modified, no SMS flipped. Read-only against Boulevard.

This session built a way for your non-engineer team to watch Path 1 in real time, a way to prove Boulevard is working correctly (not just up), and a one-page "what to watch and who to call" guide. Below is what already existed, what is new, and what gaps remain.

---

## Part 1, What monitoring already existed

| Surface | What it shows | Who can see it today | Gap for a non-engineer |
|---|---|---|---|
| **`SMS` tab, Chatlog Sheet** (`GOOGLE_CHATLOG_SHEET_ID`, via `logSmsChatMessages`) | One row per outbound **send** and per inbound **reply**: timestamp, phone, member, location, message, offer type, outcome | Anyone with the Sheet | Logs sends and replies, but **not skips-by-reason and not errors**. No rolled-up view; it is a raw append log. |
| **Redis daily counter** (`sms-sent:<date>`, `src/lib/sms-metrics.js`) | Count of sends per day | Engineer via `scripts/diag-sms-daily-counts.mjs` | Requires a script and Redis creds. Not human-facing. |
| **`sms-health-check` cron** (daily) | Emails `EMAIL_OPS_ALERTS` (defaults to matt@) if yesterday's sends fell below `SMS_MIN_DAILY_SENDS` | Matt (email) | Catches a full outage next day, not in real time. Goes to Matt only. |
| **Inline scan alert** (`maybeAlertInlineFailure` in `sms-upgrade-scan`) | Emails ops when a run has `sent=0` and `errors>0`, rate-limited hourly, includes `errorsByReason` / `skippedByReason` / `httpStatusCodes` | Matt (email) | Email only, technical content. |
| **Vercel runtime logs** | `[sms-upgrade-scan]` summary per run: `total, sent, skipped, errors, skippedByReason, errorsByReason, httpStatusCodes` | Engineer with Vercel access | Requires Vercel access and log-reading. The richest skip/error data lives here. |
| **Sentry** (`@sentry/nextjs`, project per the runbook is `sm-member-cancel-nz`) | Uncaught errors from route handlers and the browser widget | Engineer with Sentry access | DSN is set in `.env.local`; **confirm `SENTRY_DSN` is set in Vercel production** so it actually ingests in prod. Not human-facing. |
| **`chatbot.booking_error_detected` telemetry** | Booking-error events for the cancel widget | N/A yet | Lives on the unmerged branch `fix/chatbot-promo-copy-and-booking-error-telemetry` (PR #33). Not in production, and it is a cancel-bot signal, not an SMS-upgrade signal. |
| **Twilio console** (`+18885127546`) | Every outbound and inbound message, delivery status | Anyone with Twilio login | Manual, message-by-message. Good for verifying a single member. |

**The honest summary of the gap:** before this session, the only real-time, human-readable surface was the raw `SMS` tab, and it does not show the two signals that actually answer "is it broken?" (errors and skips). Everything that does show those is engineer-only (Vercel logs, Sentry) or after-the-fact email. A non-engineer had no at-a-glance "healthy / not healthy" view and no way to confirm Boulevard was working correctly.

---

## Part 2, What is new (deliverables from this session)

All files are written into the repo but **not committed** (see "How I left things" below).

1. **`scripts/boulevard-health-check.mjs`**, a read-only health check. Confirms, in plain language with PASS/FAIL and latency per operation: (1) auth + connectivity, (2) the client-lookup query returns the expected shape, (3) the `scanAppointments` path resolves without `appointments_query_failed`, (4) the duration-upgrade mutation field exists in the schema (introspection only, never fired). It captures rate-limit headers if Boulevard exposes them. **I ran it live against production Boulevard: all four checks PASS** (auth 356ms, client lookup 145ms, appointment scan 64ms returning real appointments at Brickell, `updateAppointment` present). It exits non-zero on any failure so it can be wired to a cron later. Run it with `node scripts/boulevard-health-check.mjs`.

2. **`scripts/sms-dashboard-summary.gs`**, Google Apps Script that turns the raw `SMS` tab into a clean **SUMMARY** tab: sends today, last successful send (with a red flag if stalled 3+ hours), replies today, YES count, and sends-by-location. Paste into the Sheet's Apps Script editor, run `refreshSmsSummary` once, then `installHourlyTrigger`.

3. **`docs/HOW_TO_READ_SMS_DASHBOARD.md`**, one page, plain English, for the team. What each number means, what a healthy day looks like, what is normal, when to call.

4. **`docs/TEAM_MONITORING_sms-upgrades.md`**, the watch runbook: the three things to glance at, what is normal vs a problem, the escalation chain (real names), the daily schedule, the rollback command, and the confidence test.

5. **`docs/FIRST_YES_VERIFICATION_sms-upgrades.md`**, the five-point check to confirm the first real YES worked end to end, including the in-place-not-cancel-rebook safety check.

6. **`docs/SMS_DASHBOARD_FIELD_SPEC.md`**, the spec for the small code change that would bring errors and skips-by-reason into the Sheet (see gaps below).

---

## Part 3, Gaps that remain, and the follow-up Code tasks that close them

These are specs for you to approve as one-fix-per-PR work. I did **not** build any of them, per the hard stops.

1. **Errors and skips-by-reason are not in the Sheet** (the most important gap). The dashboard can show sends, replies, YES, by-location, and last-send, but not "errors today" or "skips by reason", because the scan logs neither to the Sheet. Recommended fix is in `docs/SMS_DASHBOARD_FIELD_SPEC.md`, Option B: write one summary row per cron run to a new `SMS Runs` tab using the `summary` object the cron already builds. Low volume, no PII, one-file PR. Until then, errors reach you by alert email and live in Sentry/Vercel, which is covered in the runbook.

2. **Confirm `SENTRY_DSN` is set in Vercel production.** The DSN is in `.env.local` and the runbook treats the `sm-member-cancel-nz` Sentry project as live, but `CLAUDE.md` notes Sentry is inert until a DSN is set in the environment. Worth a 30-second `vercel env ls production` check so the error tracker actually ingests on go-live night.

3. **Outbound phone is stored unmasked in the `SMS` tab.** `maskPhoneForSheet` exists but is only used by the missed-call paths; the SMS send path logs the raw number in column D. The SUMMARY dashboard never exposes that column, so the dashboard is PII-safe, but the underlying log is not masked. Small standalone change if you want it masked. Detailed in the field spec.

4. **(Optional) Wire the health check to a cron.** Right now it is run by hand. After go-live settles, it could run hourly and alert on a non-zero exit. Noted as a follow-up, not built.

5. **Confirm Katie's monitoring role.** The go-live plan names Katie as a watcher, but her specific role is not documented in the repo. I listed her as a front-line dashboard watcher and flagged it in the runbook. Confirm what she owns.

---

## How I left things (important for the parallel Code session)

I was on branch `fix/boulevard-scan-appointments-query` (one of your four Path 1 branches). I did **not** commit anything. The six new files are present in the working tree as **untracked** files only. They are additive (a new script, a `.gs` file, and four docs) and do not modify any tracked code, so they will not collide with the Code session's PRs. When you are ready, commit them to a fresh monitoring branch (not one of the four Path 1 PR branches) so they ride separately from the go-live.

Nothing in this session touched `SMS_CRON_ENABLED`, any env var, the SMS code, or any of the four PR branches' contents.
