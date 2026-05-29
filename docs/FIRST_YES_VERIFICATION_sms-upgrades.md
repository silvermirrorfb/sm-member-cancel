# First Live YES: End-to-End Verification

The first time a real member replies **YES** to a duration-upgrade text, we want to confirm with our own eyes that the whole chain worked, not just that nothing errored. Run through this once on the first real YES (tonight or tomorrow). It takes a few minutes.

**Who does it:** Fernanda or Travis eyeballs the Boulevard appointment record. Matt or whoever is technical can check the logs and Twilio. Do it together the first time.

## The five things to confirm

1. **The reply was received.** The member's YES shows up. Look in the **SMS** tab of the dashboard spreadsheet: a row with Direction = `inbound`, Outcome = `intent_response`, and the YES text in the Message Content column. (It will also be in the Twilio console for our number, +18885127546.)

2. **The appointment was actually upgraded in Boulevard.** Open the member's appointment in Boulevard. The service / duration should now be the longer one (for example, a 30-minute facial now shows as the 50-minute service). This is the real proof. A YES that does not change the Boulevard record is a failure even if the member got a nice reply.

3. **The member got a confirmation text.** Confirm an outbound confirmation went back to the member after their YES. The clearest place to see this is the **Twilio console** (the conversation thread for that number). Note: the confirmation is sent as a direct reply, so it does **not** appear as an outbound row in the SMS spreadsheet. Do not be alarmed that the Sheet shows the inbound YES but not the outbound confirmation. That is expected. Twilio shows both.

4. **No cancellation or rebooking happened.** This is the important safety check. Path 1 changes the existing appointment in place. In Boulevard, it should be the **same appointment** (same appointment, now longer), **not** a cancelled appointment plus a brand-new one. If you see a cancelled appointment and a separate new booking, stop and tell Matt immediately, because that is not how Path 1 is supposed to work.

5. **The member is not confused.** If the member texts anything back suggesting they did not understand, got double-charged framing, or are surprised, capture their name and time and loop in Fernanda.

## If any step fails

- Step 2 fails (Boulevard not upgraded): tell Matt. The YES did not apply. There may be a support incident already queued; Matt can confirm.
- Step 4 shows a cancel-and-rebook: URGENT, tell Matt immediately. Capture the member name and time.
- Steps 1 or 3 look wrong: tell Matt with the member name and the time so the logs can be checked.

Once the first YES passes all five, we have real end-to-end confidence. After that, the day-to-day watch in TEAM_MONITORING_sms-upgrades.md is enough; you do not need to re-verify every YES by hand.
