# Testing changes without risking production (the "staging" story)

This repo has no fully-isolated staging environment. Every deploy goes to the one production project (`sm-member-cancel` on the `silver-mirror-projects` Vercel team) and runs against real Boulevard/Klaviyo/Twilio data. Until that changes (see "The real gap" below), here are the ways to verify a change without sending a real text or touching a real conversation. This is QA_ISSUES cross-cutting #5.

## 1. Dry-run the outbound SMS pipeline

`POST /api/sms/automation/pre-appointment` with `dryRun: true` runs the entire candidate -> lookup -> eligibility -> Klaviyo-consent -> offer-copy path and reports what *would* be sent (`status: "dry_run"`), without calling Twilio. This is what the verification probes in QA_ISSUES outbound-sms #8 / #9 used.

```bash
curl -s https://sm-member-cancel.vercel.app/api/sms/automation/pre-appointment \
  -H 'content-type: application/json' \
  -H "x-automation-token: $SMS_AUTOMATION_TOKEN" \
  -d '{
    "dryRun": true,
    "now": "2026-05-12T15:00:00Z",
    "locations": ["Bryant Park"],
    "discoveryWindowHours": 24
  }' | python3 -m json.tool
```

You can also pass `candidates: [{ firstName, lastName, email, phone, clientId, appointmentId }]` instead of `locations` to dry-run a specific person. Pull `SMS_AUTOMATION_TOKEN` with `vercel env pull` (production scope), and delete the file afterward.

## 2. Synthetic mode on `/api/qa/upgrade-check`

`POST /api/qa/upgrade-check` with the `x-qa-synthetic-token: $QA_SYNTHETIC_MODE_TOKEN` header lets you exercise the eligibility logic and the member-lookup logic with **zero Boulevard calls** - you supply the data:

- `syntheticMode: "eligibility"` + `syntheticProfile` + `syntheticAppointments` -> runs `evaluateUpgradeEligibilityFromAppointments` against fixtures you provide.
- `syntheticMode: "lookup"` + `firstName`/`lastName`/`email` + `syntheticCandidates` -> runs the name-match logic against fixtures.

This is the right tool for testing changes to eligibility rules, gap math, or lookup matching without depending on what's actually in Boulevard today. (The route enforces a rate limit and idempotency; see `src/app/api/qa/upgrade-check/route.js`.)

## 3. Conversational evals (bot behavior)

`__tests__/conversation-eval.test.js` plays scripted conversations against the real Claude API and checks the bot's responses against the rules that caused real incidents (honor "just cancel", no fabricated escalation, disclose the pause commitment in the offer message). Skipped by default; run it when you change `src/lib/system-prompt.txt`:

```bash
RUN_CONVERSATION_EVALS=1 ANTHROPIC_API_KEY=... npx vitest run __tests__/conversation-eval.test.js
```

Assertions are lenient (regex on forbidden/required phrasings) - a failure is a strong signal, a pass is "no obvious regression."

## 4. Vercel preview deployments

Every PR gets a preview deployment at `sm-member-cancel-<hash>-silver-mirror-projects.vercel.app`. **Caveat:** preview deployments share production environment variables, so anything that has a side effect (sending SMS, writing to the Sheets log, hitting Boulevard mutations) will affect production data. Use the preview URL for read-only / dry-run testing only; do not trigger live sends from it.

## 5. Triggering the cron manually (NOT a dry run)

`GET /api/cron/sms-upgrade-scan` with `Authorization: Bearer $CRON_SECRET` runs the real cron - it WILL send real texts to eligible guests. There is no dry-run flag on the cron itself. This is only for confirming the live path works end to end (as in the #8/#9 verifications); it is not "safe testing." Run it during the 9 AM - 7 PM ET send window or it will just report `skipped: "Outside configured send window"`.

## The real gap

None of the above is a substitute for a dedicated staging environment with its own data. The long-term answer is a separate `sm-member-cancel-staging` Vercel project with its own env vars: Boulevard sandbox credentials (if Boulevard offers a sandbox - confirm with the account rep), a test Twilio number (or `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=true` so it never actually sends), a separate Upstash Redis database (so registry/cooldown keys don't collide), and `SENTRY_DSN` pointed at a separate Sentry project. That's a provisioning decision for whoever owns the Vercel team - it was intentionally not created as part of the 2026-05-12 fix pass, because spinning up a new billable project is not a call to make unilaterally.
