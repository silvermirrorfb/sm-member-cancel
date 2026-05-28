# Runbook: SMS Path 1 Go-Live

**Audience:** Matt, with eyes on the system. This runbook assumes the four PRs from the Path 1 plan (Bug 4 scanAppointments retry, Bug 3 member-discoverability, Step 0.5 webhook phone-index, SMS_ENABLE_ADDON_FALLBACK gate extension) are MERGED to main and the Vercel deploys have completed.

**Path 1 definition:**
- `SMS_ENABLE_ADDON_FALLBACK=false` MUST be explicitly set in Vercel production. The default if unset is `true` (line 391 of `src/app/api/sms/automation/pre-appointment/route.js`), so unset means addon offers ON. Path 1 requires the explicit `false` setting; this runbook checks for it.
- `SMS_CRON_ENABLED=true` (the flip below). Duration-upgrade offers flow.
- `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK=false`. Plus the code guard at `src/lib/boulevard.js:26` walls the destructive-mutation path regardless.
- `SMS_REQUIRE_MANUAL_LIVE_APPROVAL` is your choice (off = direct send, on = each send queued for manual approval before Twilio call).

## Pre-flight checklist

Before flipping the cron, verify every one of these:

- [ ] All four Path 1 PRs are MERGED to main (in addition to the cancel-bot PRs #34-#37 from earlier 2026-05-28)
- [ ] Vercel dashboard shows the latest main commit deployed green on production
- [ ] `vercel env ls production --scope silver-mirror-projects` shows all of:
  - `SMS_ENABLE_ADDON_FALLBACK=false` (REQUIRED — explicit)
  - `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK=false`
  - `SMS_CRON_ENABLED=false` (still off — you flip it later in Step 2)
  - `SMS_AUTOMATION_TOKEN`, `SMS_UPGRADE_STATUS=live`, `SMS_CRON_LOCATIONS` (non-empty)
  - All Boulevard / Klaviyo / Twilio / Redis credentials (no `vercel env pull` needed, just confirm names exist)
- [ ] Sentry `sm-member-cancel-nz` project shows zero recent ingest errors in the last hour
- [ ] Cancellations Google Sheet shows recent rows with accurate dates (post-PR #22 server-side date-stamping fix)
- [ ] `node scripts/diag-sms-daily-counts.mjs` runs cleanly and shows today's `sms-sent:YYYY-MM-DD` counter is empty (because the cron is still off)

## Step 1: Dry-run protocol (before flipping cron)

Run a single SMS upgrade scan in dry-run mode against the production endpoint. This confirms (a) the candidate selection pipeline produces the candidates you expect, (b) duration upgrades flow through, and (c) explicit addon requests are blocked by the new gate extension.

Pull `SMS_AUTOMATION_TOKEN` first (delete the file afterward):

```bash
vercel env pull --environment production .env.production
source .env.production
rm .env.production
```

### Dry-run 1: discovery scan (Bryant Park)

```bash
curl -s https://sm-member-cancel.vercel.app/api/sms/automation/pre-appointment \
  -H 'content-type: application/json' \
  -H "x-automation-token: $SMS_AUTOMATION_TOKEN" \
  -d '{
    "dryRun": true,
    "now": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "locations": ["Bryant Park"],
    "discoveryWindowHours": 24
  }' | python3 -m json.tool
```

**Expected:**
- HTTP 200
- `summary.total > 0` (some appointments discovered in the 24h window)
- `summary.sent === 0` (dry run)
- `summary.errors === 0`
- `summary.skippedByReason` includes legitimate skip reasons: `klaviyo_sms_not_subscribed`, `no_eligible_offer`, `addon_already_on_booking`, `no_upcoming_appointment_in_window`, etc. NOT `unknown` (per cross-cutting #6 observability lesson).
- `results[]` shows per-candidate decisions. Any candidate where `offerKind === "addon"` would indicate the gate is NOT firing — investigate before flipping cron.

### Dry-run 2: explicit-addon request (Path 1 gate proof)

This synthetic call mimics a request that would have produced an addon offer pre-gate. With the gate extension active, the result MUST NOT be an addon offer.

```bash
curl -s https://sm-member-cancel.vercel.app/api/sms/automation/pre-appointment \
  -H 'content-type: application/json' \
  -H "x-automation-token: $SMS_AUTOMATION_TOKEN" \
  -d '{
    "dryRun": true,
    "offerType": "addon",
    "addOnCode": "antioxidant_peel",
    "now": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "sendTimezone": "America/New_York",
    "sendStartHour": 9,
    "sendEndHour": 17,
    "candidates": [
      {
        "firstName": "Test",
        "lastName": "Pathone",
        "email": "test-path1@example.com"
      }
    ]
  }' | python3 -m json.tool
```

**Expected:**
- HTTP 200
- `results[0].status` is `"skipped"` (or some other non-`dry_run`-with-addon-offer outcome)
- `results[0].offerKind` is NOT `"addon"`. If it IS `"addon"`, the gate extension is NOT working. STOP. Investigate before flipping cron.

### If you see addon offers being built (gate not firing)

- Confirm `vercel env ls production | grep SMS_ENABLE_ADDON_FALLBACK` shows `false`
- If it shows `true` or is missing, set it: `vercel env add SMS_ENABLE_ADDON_FALLBACK production --value false --yes` then `vercel --prod --yes` and wait for redeploy
- Re-run dry-run 2

If the gate still doesn't fire after a verified env var and deploy, do NOT flip the cron. Open an issue with the dry-run output attached.

### If you see zero candidates

- Check `summary.skippedByReason` — the most common cause is the time window being too narrow or a quiet location
- Try a different location or wider `discoveryWindowHours: 72`
- Confirm the Redis registry is populated: `node scripts/diag-sms-daily-counts.mjs` or query `sms-registry:loc:<location-id>` directly

## Step 2: Flip the cron

This is the moment of go-live. Have a second terminal open with the watch commands from Step 3 ready.

```bash
vercel env rm SMS_CRON_ENABLED production --yes 2>/dev/null
vercel env add SMS_CRON_ENABLED production --value true --yes
vercel --prod --yes
```

The redeploy is required for the env-var change to take effect (per the memory note about Vercel env quirks: env vars don't apply until the next deploy).

**Expected:** deploy completes in ~30 seconds. The cron at `/api/cron/sms-upgrade-scan` will fire on its next 10-minute tick (`*/10 * * * *`).

## Step 3: First-hour watch plan

For the first hour after the flip, keep these four watches open:

### Watch A: Vercel runtime logs for `sms-upgrade-scan`

```bash
vercel logs --follow https://sm-member-cancel.vercel.app
```

Filter your terminal for `[sms-upgrade-scan]`. Each cron run should print a summary with `sent`, `errors`, `skippedByReason`. Expected:
- `sent > 0` once an in-window candidate clears every gate
- `errors === 0`
- Addon candidates produce existing skip reasons from the `addonUnavailableReason` ladder (`no_eligible_offer`, `insufficient_addon_gap`, `addon_already_on_booking`) when the gate suppresses them — NOT a built `selectedOffer.offerKind: "addon"` in `results[]`
- No `unknown` skip reasons (per cross-cutting #6)
- No `http_*` reasons in `errorsByReason` (per cross-cutting #6 observability fix; if these appear, an HTTP failure is being surfaced correctly which is itself a sign the cron is hitting issues)

### Watch B: Twilio outbound message log

The Twilio console for `+18885127546`. Confirm each `[sms-upgrade-scan]` reported send corresponds to a real Twilio message with status `delivered` or `sent`. Failed messages or unexpected `undelivered` should be investigated.

### Watch C: Inbound webhook (Step 0.5 verification)

If any guest replies YES/NO to an outbound SMS, the webhook at `/api/sms/twilio/webhook` should resolve them by phone-index without a Boulevard round-trip. Confirm in Vercel logs that the phone-index path fires (the Step 0.5 commit includes log lines for phone-index hit vs fallback). If you see only fallback hits and no phone-index hits, the seed cron may not be populating the index — check `sms-registry:phone:<E164>` keys in Upstash Redis directly.

### Watch D: Sentry

`sm-member-cancel-nz` project on sentry.io. Any new errors in the first hour are investigated immediately. The Bug 4 retry layer should suppress transient Boulevard failures; if Sentry shows a spike of Boulevard-related errors, the retry isn't masking them so it's a real problem (a deeper Boulevard outage, an auth issue, etc.).

## Step 4: Rollback in under 60 seconds

If any of the watches show a problem, rollback the cron flip:

```bash
vercel env rm SMS_CRON_ENABLED production --yes
vercel env add SMS_CRON_ENABLED production --value false --yes
vercel --prod --yes
```

Outbound SMS stops on the next cron tick (worst case 10 minutes from rollback). The redeploy completes in under 60 seconds.

**For a deeper rollback** (e.g., the gate extension itself misbehaved): revert the gate-extension PR via the GitHub UI, redeploy, then flip the cron again.

**For an addon-only rollback** (e.g., addon offers are firing when they shouldn't): set `SMS_ENABLE_ADDON_FALLBACK=false` (it should already be set, but verify with `vercel env ls`) and redeploy. This blocks addons without stopping duration upgrades.

## Open questions for Matt (resolve before or during go-live)

1. **Travis ghost-upgrade backfill:** is the backfill complete, or do we need to hold on Step 0.5's webhook path until it lands? This runbook assumes Step 0.5 is ready to go; surface if not.
2. **Location scope at launch:** does Path 1 launch at all 10 locations or starts at a subset (e.g., Bryant Park only as a soak)? Default in the cron is all locations the `SMS_CRON_LOCATIONS` env var lists; reduce by editing that var if the call is to soak.
3. **Send cap:** the cron's `SMS_CRON_MAX_CANDIDATES` defaults to 40 per run. With a 10-minute tick that's ~5,760/day theoretical max. Is that the right ceiling for Path 1 launch, or do we want to cap lower for the first 48 hours?
4. **Manual-approval gate during launch:** does Matt want `SMS_REQUIRE_MANUAL_LIVE_APPROVAL=true` for the first hour as a belt-and-suspenders, even though it would slow each send to a manual click?

## Reference: what each Path 1 PR does

| PR | What it landed | Why it matters for go-live |
|---|---|---|
| Bug 4 retry | `fetchBoulevardGraphQL` retries 429/5xx/network errors with exponential backoff (bounded by `BOULEVARD_FETCH_MAX_RETRIES`, default 2) | Boulevard's burst limits don't translate to terminal cron failures anymore |
| Bug 3 namesLikelyMatch | Hardens the false-positive surface in member-discoverability matching | Fewer false `member_not_found` skip reasons in the funnel; more eligible guests reach the consent gate |
| Step 0.5 phone-index | Webhook resolves inbound SMS by Redis phone-index instead of Boulevard per-message | YES/NO reply round-trip latency drops; fewer Boulevard calls per inbound webhook |
| SMS_ENABLE_ADDON_FALLBACK extension | Explicit addon requests now honor the gate; setting the var to false blocks all addon paths | Path 1 ships with duration-upgrade offers only; addon offers are Path 2 (later) |
