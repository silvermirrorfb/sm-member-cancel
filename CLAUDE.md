# CLAUDE.md -- sm-member-cancel (Member Cancellation Chatbot)

> Inherits from: ~/Documents/M-Central/CLAUDE.md
> Repo: silvermirrorfb/sm-member-cancel
> URL: sm-member-cancel.vercel.app/widget
> Vercel project: prj_2eN5VZwqjEZ01m28Zr6PrGj3b8oX

## What This Is

AI chatbot that handles member cancellation retention and general service Q&A for Silver Mirror. Deployed as an embeddable widget.

## Stack
- Next.js 14
- Claude Sonnet API (via claude.js, 154 lines)
- Boulevard GraphQL (via boulevard.js, 845 lines)
- Upstash Redis (sessions + rate limiting)
- Google Sheets logging
- SMTP email notifications (via notify.js, 667 lines)
- Twilio SMS (gated: `SMS_UPGRADE_STATUS=pending`)

## Two Modes
- **GENERAL** (default): Service/pricing/location Q&A
- **MEMBERSHIP**: Triggered by cancel/pause/billing mentions. Boulevard lookup, structured retention flow with tiered offers

## Key Files
- `boulevard.js` (845 lines) -- Boulevard API integration
- `message/route.js` (710 lines) -- Main message handling
- `notify.js` (667 lines) -- Email notifications
- `widget/page.js` (756 lines) -- Widget UI
- `system-prompt.txt` (555 lines) -- Claude system prompt
- `end/route.js` (205 lines) -- Session end handling

## Google Sheets
- Cancellations: `1zq3a5VrYVKXNu_ITfPcMcX6jZNTJepzNGIcy49c6uTg`
- Chatlogs: `1Wu7th9Z9tO9nQuy7j2FyEgm1YKhDwvgcVPZDprE8z-Y`

## CRITICAL Warnings
- Old Zapier bot is STILL ACTIVE on silvermirror.com (~48% of sessions). Do not assume this bot handles all traffic.
- Boulevard API URL is set via `BOULEVARD_API_URL` env var. Do NOT suggest changing it.
- 164 tests passing as of last check

## SMS Upgrade System (separate cron subsystem)
- Redis-backed member registry seeds daily at 6 AM ET via `/api/cron/sms-registry-seed`
- Pages Boulevard `clients` query, filters by `primaryLocation`, stores in Upstash Redis (7-day TTL)
- Scan cron runs every 30 min, Fisher-Yates shuffle, 50 guests per run
- Klaviyo SMS consent (`SUBSCRIBED`) is legal gate before any Twilio send
- 3,803 guests seeded across all 10 locations

## Open Issues
- Year 5 perk wording
- SMS v2 copy
- Gift card + referral gaps in prompt
- Emoji leaking

## Rules
- Cosmetic-only language
- No em dashes
- No medical terminology
