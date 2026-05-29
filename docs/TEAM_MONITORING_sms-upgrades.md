# Team Monitoring: SMS Upgrade Texts (Path 1)

**Who this is for:** Travis, Katie, Fernanda, and the front-desk leads. You do not need to be technical to use this. A front-desk lead should be able to read this in five minutes and know what to watch and who to call.

**What is live:** We are sending members a text before their appointment offering to upgrade to a longer facial. If they reply YES, the system makes their appointment longer in our booking system (Boulevard) and texts them back to confirm. Add-on offers are turned OFF right now on purpose. This is "Path 1": duration upgrades only.

**Two places you look:** the **SUMMARY** tab of the SMS dashboard spreadsheet, and the result of the Boulevard health check (someone technical runs it). That is it.

---

## A. The three things to glance at, in order

1. **Error count.** Should be about zero. You will not see errors in the spreadsheet. If errors happen, Matt gets an automatic alert email, and they show in our error tracker (Sentry). So "no error email to Matt" is the all-clear. This is the most important signal.

2. **Last successful send time.** On the SUMMARY tab. During business hours (about 9am to 7pm Eastern) this should be recent, within the last hour or two. The box turns red if we have not sent anything for over three hours during the day. A multi-hour gap in the middle of a busy day means something stalled.

3. **Boulevard health check.** Should say PASS. Someone technical runs `node scripts/boulevard-health-check.mjs`. Once in the morning is enough on a normal day, more often on go-live day. PASS means our booking system is answering our specific queries correctly, not just "up".

If those three are good (no error email, recent send, health check PASS), the system is healthy.

---

## B. What is NORMAL and should not worry you

The system skips a lot of members on purpose. None of this is a malfunction:

- **Members who have not opted in to texts get skipped.** We are legally required to skip them. Expected.
- **Add-on offers are skipped.** They are intentionally turned off for Path 1. We only send the longer-facial upgrade. Expected.
- **Recently-texted members get skipped** (cooldown). We do not pester people. Expected.
- **Members with no upcoming appointment in the window get skipped.** Expected.
- **Members whose appointment already has the add-on get skipped.** Expected.
- **A low send count on a slow appointment day.** Fewer appointments means fewer people to offer. Expected.

The technical skip names you might hear (`klaviyo_not_subscribed`, `addon_offers_disabled`, `cooldown`, `no_upcoming_appointment_in_window`, `addon_already_on_booking`) are all the system working as designed. The word "skip" is not a problem. The word "error" is.

---

## C. What is a PROBLEM, and what to do

**Errors climbing** (Matt got an error alert email, or any "error" outcome appears). Tell Matt.

**Zero sends during a busy day** (sends stuck at zero, or last-send time red during business hours). Tell Matt.

**A member says they got a weird, duplicate, or wrong text.** Write down the member's name and the time, then tell Fernanda or the memberships team.

**The Boulevard health check FAILS.** This is the big one. It means our booking system is not answering correctly and YES replies might not apply. Tell Matt right away.

**A member says their appointment was changed or cancelled and they did not ask for it.** URGENT. Tell Matt immediately, and capture the member's name and the time. In Path 1 the system only makes an appointment longer in place; it never cancels or rebooks. So this should be impossible. If a member ever reports it, we want to know instantly. (This is the situation we are most careful about. Escalate it the moment you hear it.)

---

## D. Who to call (escalation chain)

- **First line, during the day:** the front-desk leads and Katie watch the SUMMARY tab. (Note: Katie is named here per the go-live plan; her exact monitoring role is not written down in our repo docs, so Matt should confirm what she owns.)
- **Anything technical** (errors, zero sends, health check fails, the system looks broken): **Matt**.
- **Anything member-facing** (a member is confused, upset, got a weird text, a complaint): **Fernanda / the memberships team**.
- **Operational or location-specific questions** (does a location want to pause, a location is behaving oddly): **Travis**.
- **Legal or compliance questions** go to Matt, who decides whether to involve Justin Prochnow (outside regulatory counsel). Do not route these anywhere else.

Note: Tahir is not the contact for this system. He owns a different backend. For anything about these upgrade texts, it is Matt, Fernanda, or Travis as above.

**The emergency stop (Matt only).** If we need to stop all upgrade texts immediately, Matt runs this and sends stop within one cron cycle (at most about 10 minutes):

```
vercel env rm SMS_CRON_ENABLED production --yes
vercel env add SMS_CRON_ENABLED production --value false --yes
vercel --prod --yes
```

Nothing is deleted; it just pauses sending. Ask Matt to run this if errors are climbing, if members report unexpected appointment changes, or if the Boulevard health check is failing and sends are still going out. When in doubt, it is safe to pause.

---

## E. Daily check schedule

**Morning.** Someone technical runs the Boulevard health check (`node scripts/boulevard-health-check.mjs`) and confirms PASS. Glance at the overnight picture: any error alert email to Matt? (There should be none; we do not send overnight.)

**Midday.** A front-desk lead or Katie glances at the SUMMARY tab. Sends climbing? Last-send time recent and not red? Any error email?

**End of day.** Glance at the SUMMARY tab one more time: total sends, replies, YES count, and confirm no errors came in.

Who does each: morning health check is Matt or whoever is technical that day; midday and end-of-day glances are the front-desk leads / Katie; Fernanda handles any member-facing items that came up; Travis handles location/operational calls.

---

## F. The "is it actually working?" confidence test

By the end of a normal day, all of these should be true:

- At least a handful of duration upgrades were successfully applied in Boulevard (members who said YES got their appointment lengthened).
- Members who said YES got a confirmation text back.
- Zero unexpected appointment changes (nobody reports a cancellation or change they did not request).
- The Boulevard health check passed every time it was run.

If all four hold, the system is genuinely working, not just "not erroring". If any one of them is off, treat it as a problem and use section C.

For confirming the very first real YES end to end, see **FIRST_YES_VERIFICATION_sms-upgrades.md**.
