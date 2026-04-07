# Outbound SMS Dry-Run Matrix (2026-03-11)

- Run timestamp (UTC): `2026-03-11T20:25:54Z`
- Environment: `Production` (`sm-member-cancel.vercel.app`)
- Route: `POST /api/sms/automation/pre-appointment`
- Mode: `dryRun=true` (no SMS sends)
- Controls:
  - `enforceSendWindow=false`
  - `enforceKlaviyoOptIn=false`
  - `windowHours=24`
  - `sendTimezone=America/New_York`

## Summary
- total candidates: `3`
- dry-run sends: `0`
- skipped: `3`
- errors: `0`

## Send/No-Send Matrix
| Name | Email | Tier | Profile Phone | Status | Reason | Matched Contact |
|---|---|---:|---|---|---|---|
| Debbie Von Ahrens | debbievonahrens@mac.com | 30 | +19175831865 | skipped | no_upcoming_appointment_in_window | debbievonahrens@mac.com |
| Matt Maroone | mattmaroone@gmail.com | 30 | +12134401333 | skipped | no_upcoming_appointment_in_window | mattmaroone@gmail.com |
| Sandra Bellew | sandra.bellew@silvermirror.com | 50 | +12402348191 | skipped | no_upcoming_appointment_in_window | sandra.bellew@silvermirror.com |

## Notes
- This run confirms live member lookup is healthy for all three candidates.
- No outbound offer was eligible in the configured appointment window at run time.
- Because this is `dryRun=true`, nothing was sent to Twilio.
