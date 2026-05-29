# How to Read the SMS Dashboard

This is the spreadsheet that shows what our pre-appointment "upgrade your facial to a longer one" texts are doing. You do not need to be technical to read it. This page tells you what every number means and when to worry.

Open the spreadsheet and look at the **SUMMARY** tab. It refreshes on its own. The "Last refreshed" line at the top tells you how fresh the numbers are.

## The four numbers that matter

**Sends today.** How many upgrade texts we sent members today. On a normal business day this climbs through the day and settles somewhere reasonable for how busy our appointment book is. A quiet appointment day means a lower number, and that is fine.

**Last successful send.** The time we last sent a text. During business hours (roughly 9am to 7pm Eastern) this should be recent, usually within the last hour or two. If this box turns red, it means we have not sent anything in over three hours during the day, which can mean the system stalled. That is worth a look.

**Replies received today.** How many members texted us back (YES, NO, or anything else).

**YES replies today.** How many members said yes to upgrading. This is the good one. These are members getting a longer facial because we asked.

## The "watch numbers" section (light red)

Three things you cannot read off this spreadsheet directly, with where to find them instead:

**Errors today.** This is the number we care about most, and it does not live in this Sheet. Errors show up in our error tracker (Sentry) and in an automatic alert email that goes to Matt. If something is breaking, Matt gets an email. You do not need to hunt for errors here.

**Skips by reason.** The system intentionally skips a lot of members, and that is normal and expected (see the next section). The full skip breakdown lives in our system logs, not this Sheet. You do not need to watch it day to day.

**Boulevard health.** Boulevard is our booking system. There is a quick check someone technical can run (`node scripts/boulevard-health-check.mjs`) that confirms it is working. Once a day in the morning is plenty.

## What a healthy day looks like

Sends today is climbing during business hours. Last successful send is recent and not red. Replies are trickling in, and some of them are YES. Nobody got an error email. That is a good day, even if the totals are modest.

## What is normal and is NOT a problem

A lot of members get skipped, and almost all of it is expected and on purpose:

- Members who have not opted in to texts are skipped. We are legally required to skip them. This is normal.
- Add-on offers are turned off right now on purpose. We are only sending the "longer facial" upgrade. Anything about add-ons being skipped is expected.
- Members we already texted recently are skipped (we do not pester people).
- Members with no upcoming appointment in the window are skipped.

None of that is a malfunction. The system is supposed to be picky.

A low send count on a slow appointment day is also normal. Fewer appointments means fewer people to offer an upgrade to.

## When to tell someone

- **Last successful send turned red** (no sends for 3+ hours during the day) → tell Matt.
- **Sends today is stuck at zero on a busy day** → tell Matt.
- **A member tells us they got a weird, duplicate, or wrong text** → write down their name and the time, and tell Fernanda / the memberships team.
- **A member says their appointment got changed or cancelled and they did not ask for it** → this should not be possible right now, so treat it as urgent and tell Matt immediately. Capture the member name and time.

The fuller "who watches what and who to call" guide is in **TEAM_MONITORING_sms-upgrades.md**. This page is just how to read the spreadsheet.
