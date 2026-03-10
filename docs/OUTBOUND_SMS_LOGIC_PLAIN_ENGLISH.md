# Outbound SMS Upgrade Logic (Plain English)

This document explains how the outbound upgrade texts work in simple terms.

## Goal

Before an appointment, we may text a guest an upgrade offer (example: 30 -> 50 minutes) **only if it is truly available** and **only if SMS consent is valid**.

## Safety First (Non-Negotiables)

1. No outbound marketing SMS unless the guest is SMS-opted-in in Klaviyo.
2. No send outside the allowed send window (default 9:00 AM to 5:00 PM).
3. No upgrade offer unless the schedule gap check says the upgrade can fit.
4. If there is ambiguity (example: multiple appointments and no appointment ID), the bot does **not** guess.

## Step-by-Step Flow

## 1) Candidate comes in

Candidate can be provided directly (name + email/phone) or from the queue.

## 2) Send window check

If the current time is outside the SMS send window, the candidate is queued (or skipped if queueing is disabled).

## 3) Find the guest profile in Boulevard

The system tries to match by provided contact info and name.

If no profile is found, result is `member_not_found` (even for non-members, this means we could not reliably match the client profile).

## 4) Find the appointment(s)

The system scans upcoming appointments for that client in the lookahead window (default 6 hours).

Important safety behavior:
- If exactly one upcoming appointment exists, it is used.
- If multiple upcoming appointments exist and no `appointmentId` is given, it fails safe with:
  `multiple_upcoming_appointments_require_appointment_id`

## 5) Determine current service duration correctly

The system uses appointment start/end time but accounts for transition/prep time, so a 30-minute service plus transition is still treated as a 30-minute service.

Upgrade targets:
- 30 -> 50
- 50 -> 90
- 90 -> no upgrade target

## 6) Check if upgrade can fit in schedule

The system checks the available gap after the appointment against:
- Added treatment minutes needed for the upgrade
- Required prep/transition buffer
- Next provider commitment (or location fallback if provider identity is unavailable)

If gap is too small: `insufficient_gap`.

## 7) Determine price shown in SMS

Member pricing is only used when account is active and has a valid tier.
Otherwise non-member pricing is used.

## 8) Klaviyo SMS consent gate (source of truth)

With `SMS_REQUIRE_KLAVIYO_OPT_IN=true`, no text is sent unless Klaviyo says SMS marketing is allowed.

Typical skip reasons:
- `klaviyo_sms_not_subscribed`
- `klaviyo_sms_blocked`

## 9) Send offer message

If all checks pass, send a single SMS offer.

The SMS text system enforces:
- Plain text (ASCII-safe)
- Under 150 chars max
- Target around 140 chars when possible

## 10) Guest replies YES/NO

- `NO`: keep appointment as-is.
- `YES`: re-check availability immediately (same appointment, same target) to avoid race conditions.

If still eligible, system attempts to apply the upgrade in Boulevard (see next section).

---

## Does the bot change Boulevard automatically, or does a human?

Both are possible, depending on configuration.

### Automatic Boulevard change happens only if ALL are true:

1. `BOULEVARD_ENABLE_UPGRADE_MUTATION=true`
2. `BOULEVARD_SERVICE_ID_50MIN` is set
3. `BOULEVARD_SERVICE_ID_90MIN` is set
4. Boulevard API key has permission to run appointment update mutation

If any of the above is missing, the bot cannot apply the upgrade mutation and a human must finalize in Boulevard.

### Current production state (as of March 10, 2026)

Configured:
- `BOULEVARD_API_KEY`
- `BOULEVARD_API_SECRET`
- `BOULEVARD_API_URL`
- `BOULEVARD_BUSINESS_ID`
- `SMS_REQUIRE_KLAVIYO_OPT_IN=true`

Not present in current production env pull:
- `BOULEVARD_ENABLE_UPGRADE_MUTATION`
- `BOULEVARD_SERVICE_ID_50MIN`
- `BOULEVARD_SERVICE_ID_90MIN`

So right now, **human completion is still required** for the actual appointment service change unless those values are added and mutation permissions are enabled.

---

## Common Skip Reasons (for QA)

- `outside_send_window` / `queued_outside_send_window`
- `member_not_found`
- `no_upcoming_appointment_in_window`
- `multiple_upcoming_appointments_require_appointment_id`
- `insufficient_gap`
- `missing_profile_phone`
- `klaviyo_sms_not_subscribed` / `klaviyo_sms_blocked`
- `offer_already_sent` / `offer_already_pending` / `offer_declined`

---

## QA Quick Script (Plain Language)

1. Confirm guest is SMS-opted-in in Klaviyo.
2. Confirm one specific appointment in next 6 hours.
3. Run dry-run and verify result is `eligible`.
4. Confirm offer message and price are correct (member vs non-member).
5. Send live offer.
6. Reply `YES`.
7. Confirm:
   - If mutation is enabled: appointment service is updated in Boulevard.
   - If mutation is disabled: no automatic service change; staff must update manually.

