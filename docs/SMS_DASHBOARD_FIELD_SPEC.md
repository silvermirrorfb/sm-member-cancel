# SMS Dashboard, what the Sheet logs today, and the small change to close the gap

**Status:** Spec only. This is a hand-off for a future one-fix-per-PR Code task. No code change is made here. Per `CLAUDE.md`, this is scope for Matt to approve, not for a monitoring session to ship.

**Audience:** Matt / whoever picks up the follow-up PR.

---

## What the SMS log Sheet captures today

The bot writes to the `SMS` tab of the Chatlog sheet (`GOOGLE_CHATLOG_SHEET_ID`) via `logSmsChatMessages` in `src/lib/notify.js`. Columns:

| Col | Header | Example for a duration send |
|---|---|---|
| A | Session ID | `sms-...` |
| B | Timestamp | ISO timestamp |
| C | Direction (inbound/outbound) | `outbound` |
| D | Phone | the member's number |
| E | Member Name | member name |
| F | Location | `Bryant Park` |
| G | Message Content | the offer text that was sent |
| H | Offer Type | `duration` |
| I | Outcome | `initial_sent` / `reminder_sent` (sends), `intent_response` (a YES/NO reply), `stop_received`, `start_received` |

A row is written in exactly two situations:

1. **An outbound text is actually sent**, from `src/app/api/sms/automation/pre-appointment/route.js` (~line 1098), right after the Twilio send succeeds.
2. **An inbound reply arrives**, from `src/app/api/sms/twilio/webhook/route.js` (several call sites), including YES/NO (`intent_response`), STOP, START.

## The gap (what the dashboard CANNOT show from the Sheet)

Two of the most important monitoring signals are **not** in the Sheet:

- **Skips by reason** (`klaviyo_not_subscribed`, `cooldown`, `addon_offers_disabled`, `no_upcoming_appointment_in_window`, `addon_already_on_booking`, etc.). When the scan skips a candidate, the route does `continue` **without** writing a Sheet row. Skip reasons exist only in the cron response `summary.skippedByReason` and the Vercel `[sms-upgrade-scan]` log line.
- **Errors** (`http_500`, the per-candidate `error` outcome). The `catch` block in the pre-appointment route pushes the error into `results[]` but does **not** call `logSmsChatMessages`. Errors surface only in `summary.errorsByReason`, the Vercel log, Sentry, and the inline ops-alert email.

Also note: when a member replies **YES** and the upgrade is applied, the confirmation text is returned as a Twilio TwiML reply, not sent via `sendTwilioSms`, so **the confirmation is not logged as an outbound row**. The Sheet shows the inbound `intent_response` row but not the outbound confirmation. Twilio's console shows both.

Net effect: the dashboard can show sends, sends-by-location, replies, YES count, and last-send time. It cannot show "errors today" or "skips by reason" without one of the changes below.

---

## Recommended follow-up: Option B, a daily/run summary row (low volume, low risk)

Write one row per cron run (or per day) capturing the summary object the cron already builds. The cron route at `src/app/api/cron/sms-upgrade-scan/route.js` already computes:

```
summary = { total, sent, skipped, errors, skippedByReason, errorsByReason, httpStatusCodes }
```

Add a new tab `SMS Runs` and a small `logSmsRunSummary(summary)` writer in `notify.js`. Suggested columns:

| Timestamp | Locations | Candidates | Sent | Skipped | Errors | skippedByReason (JSON) | errorsByReason (JSON) |

Call it once at the end of each scan run (right where `[sms-upgrade-scan]` is logged). The dashboard Apps Script can then read `SMS Runs` and show "errors today" and "skips by reason" as real numbers. This adds ~144 rows/day max (one per 10-min tick), which is trivial.

Why this option: it mirrors data the cron already has in memory, keeps PII out of the Sheet entirely (it's aggregate counts), and is a clean one-file, one-fix PR.

## Alternative: Option A, per-candidate rows on skip and error

In the pre-appointment route, also call `logSmsChatMessages` on the skip `continue` and in the `catch`, with `direction: 'outbound'`, `outcome: 'skipped'` or `'error'`, and `offerType:` set to the reason. This gives a complete per-candidate audit trail but adds a row for every skipped candidate (thousands/day, since `klaviyo_not_subscribed` is common and expected). If you take this path, **mask the phone** with `maskPhoneForSheet` (the outbound send path currently logs the raw number, see PII note below) and expect to need a retention/cleanup plan for the tab.

Recommendation: ship Option B. It answers the "is it broken?" question without the volume and PII footprint of Option A.

---

## Separate, smaller observation: outbound phone is not masked in the Sheet

The outbound send call passes the raw `profilePhone` to `logSmsChatMessages`; `maskPhoneForSheet` exists in `notify.js` but is only used by the missed-call paths. So the `SMS` tab currently stores full member numbers in column D. The SUMMARY dashboard never exposes column D (it only aggregates), so the dashboard itself is PII-safe, but if you want the underlying log masked too, route the SMS `phone` field through `maskPhoneForSheet` as well. Flagging as its own tiny change, not bundled with the above.
