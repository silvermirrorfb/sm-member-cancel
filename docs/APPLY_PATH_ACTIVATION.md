# Apply-Path Activation Runbook (SMS duration upgrade)

How to safely turn ON the live booking upgrade (`BOULEVARD_ENABLE_BOOKING_UPGRADE`) so that a member
texting YES to a 50-minute offer actually gets their appointment extended in Boulevard.

**Status today: the flag is OFF. With it OFF, a YES is handled safely by a human (manual_followup), no
booking is touched. Nothing in this document changes that until a person deliberately follows it.**

This is owner-gated on purpose. A previous attempt destroyed a real booking (the "Maureen" incident),
which is why activation requires a controlled dry-run on ONE test appointment with eyes on Boulevard
before and after.

---

## What the apply actually does (plain English)

When ON, a YES triggers an in-place edit of the SAME appointment (no cancel, no rebook):
1. Opens a draft over the existing appointment.
2. Adds the 50-minute service.
3. Removes the 30-minute service (added first, removed second, so the booking is never empty).
4. Sets the price to the exact total the member was quoted.
5. Commits the draft back to the SAME appointment id, with `notifyClient: false` (we send our own SMS).
6. Reads the appointment back to confirm the swap.

If ANY step errors or returns a blocking warning, it aborts BEFORE the commit and the appointment is left
exactly as it was. There is no `cancelAppointment` and no fresh `bookingCreate` in this path.

---

## Before you start (preconditions)

- [ ] `BOULEVARD_SERVICE_ID_50MIN` is set in Vercel production to the correct 50-minute Esthetician's
      Choice service id. (The apply adds this exact service. Wrong id = wrong service added.)
- [ ] `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` is OFF and STAYS OFF. That is the destructive cancel-and-
      rebook path. Do not enable it. You are only turning on the in-place edit.
- [ ] Pick the quietest possible window (early morning before the day's offers go out). Important: turning
      the flag ON enables the live apply for EVERY YES, not just your test. There is no per-appointment
      allowlist. So you want a window where no other live offers are outstanding, do the one test fast,
      then decide. If unsure whether offers are outstanding, run the test outside the 9am-7pm ET send
      window so the cron is not sending new offers during your test.
- [ ] Two people ready: one watching Boulevard, one sending the test YES. Have this doc open.

---

## Step 1: Choose ONE test appointment

- Use a controlled, internal test booking, NOT a paying guest. Ideally a staff/test member account with a
  real upcoming 30-minute appointment at a real location.
- The test member's mobile must be `SUBSCRIBED` in Klaviyo (otherwise no offer/Reply path fires).

## Step 2: Record the BEFORE state from Boulevard (write it down)

For the test appointment, note exactly:
- Appointment ID: ________________
- Service + duration: ____________ (should be the 30-minute service)
- Date / start time: ____________
- Price on the booking: $________
- Status: ____________ (booked)

## Step 3: Enable the flag and redeploy

1. In Vercel (silver-mirror-projects -> sm-member-cancel) set, for Production:
   `BOULEVARD_ENABLE_BOOKING_UPGRADE = true`
   (Use `vercel env add BOULEVARD_ENABLE_BOOKING_UPGRADE production --value true --yes`, or the Vercel
   dashboard.)
2. REDEPLOY production. An env change does NOT take effect until you redeploy (`vercel --prod --yes`, or
   push/redeploy). Confirm the new deploy is READY.

## Step 4: Get the test member a live offer, then reply YES

- Make sure the test member has a live duration offer for the test appointment (either it went out via the
  normal cron, or trigger one). The member must have an outstanding pending offer.
- From the test member's phone, reply `YES` to the offer (to +18885127546).
- The member should receive a confirmation SMS that quotes the same price as the offer.

## Step 5: Check the AFTER state in Boulevard (this is the gate)

Confirm ALL of the following on the test appointment:
- [ ] SAME appointment ID as Step 2 (it must NOT have changed).
- [ ] Service is now the 50-minute Esthetician's Choice (duration shows 50 minutes).
- [ ] Price equals the quoted total (member 30->50 = $139 total; non-member = $169 total).
- [ ] Start time unchanged.
- [ ] Status still booked.
- [ ] There is NO duplicate/second appointment for that member, and the original is NOT cancelled.

If every box is checked: the apply works. Go to Step 6.

## Step 6: Decide (Matt's call)

- To keep it LIVE for everyone: leave `BOULEVARD_ENABLE_BOOKING_UPGRADE = true`. From now on every YES
  edits the booking automatically. Watch the first day of real YES replies.
- To go back to dry-run-only: set the flag OFF again (Step R) until you are ready.

---

## Step R: ROLLBACK (do this immediately if anything in Step 5 is wrong)

Trigger rollback if the appointment ID changed, a duplicate appeared, the original got cancelled, the
price is wrong, or anything looks off.

1. Set `BOULEVARD_ENABLE_BOOKING_UPGRADE = false` in Vercel production (or remove the variable).
2. REDEPLOY production and confirm READY. Now every YES is back to the safe human-handled path.
3. Manually fix the test appointment in Boulevard (restore it to the 30-minute service, or fix the
   duplicate/cancellation). If a real booking was damaged, this is the "Maureen" failure mode: stop, fix
   the booking by hand, and escalate to Matt before any further attempt.
4. Do NOT retry until the cause is understood. The code aborts before commit on its own detected errors,
   so a bad AFTER state means something the code did not catch; that needs investigation, not a re-run.

---

## Quick reference

- Flag to flip: `BOULEVARD_ENABLE_BOOKING_UPGRADE` (true = live apply, false/unset = safe manual handoff).
- Never enable: `BOULEVARD_ENABLE_CANCEL_REBOOK_FALLBACK` (destructive cancel-rebook).
- Every env change needs a redeploy to take effect.
- Apply is in-place on the SAME appointment id; a changed id is the red flag that means rollback.
- Pricing source of truth: member 50-min total $139, non-member total $169 (do not change these constants
  as part of activation).
