# Upgrade Check QA Runbook

## Endpoint
- `POST /api/qa/upgrade-check`

## Auth Headers
- `x-qa-token: <QA_UPGRADE_CHECK_TOKEN>`
- `x-qa-synthetic-token: <QA_SYNTHETIC_MODE_TOKEN>` (required only when `syntheticMode` is used)

## Quick Production Probe (real lookup)
```bash
npx vercel curl /api/qa/upgrade-check -- --request POST \
  --header "Content-Type: application/json" \
  --header "x-qa-token: $QA_UPGRADE_CHECK_TOKEN" \
  --data '{
    "firstName": "Debbie",
    "lastName": "Von Ahrens",
    "email": "debbievonahrens@mac.com",
    "debug": true
  }'
```

## Synthetic Probe (lookup fallback)
```bash
npx vercel curl /api/qa/upgrade-check -- --request POST \
  --header "Content-Type: application/json" \
  --header "x-qa-token: $QA_UPGRADE_CHECK_TOKEN" \
  --header "x-qa-synthetic-token: $QA_SYNTHETIC_MODE_TOKEN" \
  --data '{
    "syntheticMode": "lookup",
    "firstName": "Sandra",
    "lastName": "Bellew",
    "email": "sandra.bellew+qa@gmail.com",
    "syntheticCandidates": [
      { "id": "urn:blvd:Client:1", "firstName": "Sandra", "lastName": "Bellew", "email": "sandra.bellew@icloud.com" }
    ]
  }'
```

## Synthetic Probe (eligibility math)
```bash
npx vercel curl /api/qa/upgrade-check -- --request POST \
  --header "Content-Type: application/json" \
  --header "x-qa-token: $QA_UPGRADE_CHECK_TOKEN" \
  --header "x-qa-synthetic-token: $QA_SYNTHETIC_MODE_TOKEN" \
  --data '{
    "syntheticMode": "eligibility",
    "firstName": "Jane",
    "lastName": "Smith",
    "email": "jane@example.com",
    "targetDurationMinutes": 50,
    "now": "2026-03-09T17:00:00Z",
    "syntheticProfile": {
      "id": "urn:blvd:Client:jane",
      "firstName": "Jane",
      "lastName": "Smith",
      "email": "jane@example.com",
      "membershipTier": "30",
      "accountStatus": "ACTIVE",
      "locationId": "urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65"
    },
    "syntheticAppointments": [
      {
        "id": "appt-1",
        "clientId": "urn:blvd:Client:jane",
        "startOn": "2026-03-09T18:00:00Z",
        "endOn": "2026-03-09T18:30:00Z",
        "locationId": "urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65"
      }
    ]
  }'
```

## Idempotency Probe
Use a unique key per test run.
```bash
npx vercel curl /api/qa/upgrade-check -- --request POST \
  --header "Content-Type: application/json" \
  --header "x-qa-token: $QA_UPGRADE_CHECK_TOKEN" \
  --header "x-idempotency-key: qa-test-001" \
  --data '{"firstName":"Debbie","lastName":"Von Ahrens","email":"debbievonahrens@mac.com"}'
```

## Expected Headers
- `X-Request-Id`
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-Idempotency-Key` (when provided)
- `X-Idempotency-Replayed` (when replayed)

## Common Failure Modes
- `401 Unauthorized`: wrong or stale `x-qa-token`.
- `401 Unauthorized synthetic mode`: missing/wrong `x-qa-synthetic-token`.
- `404 member_not_found`: Boulevard lookup miss or transient upstream issue.
- `429 Too many requests`: use throttling in batch QA.

## Safe Batch Cadence
- Keep batch requests at `~5s` spacing to avoid QA route limits.

## SMS Endpoints
- Twilio inbound webhook: `POST /api/sms/twilio/webhook`
- Pre-appointment outbound automation: `POST /api/sms/automation/pre-appointment`

### Twilio inbound requirements
- Twilio should send form-encoded payload with `From`, `Body`, and `MessageSid`.
- If `TWILIO_AUTH_TOKEN` is set, signature validation is enforced via `X-Twilio-Signature`.

### Outbound automation request
```bash
npx vercel curl /api/sms/automation/pre-appointment -- --request POST \
  --header "Content-Type: application/json" \
  --header "x-automation-token: $SMS_AUTOMATION_TOKEN" \
  --data '{
    "dryRun": true,
    "now": "2026-03-09T17:00:00Z",
    "windowHours": 6,
    "sendTimezone": "America/New_York",
    "sendStartHour": 9,
    "sendEndHour": 17,
    "candidates": [
      {
        "firstName": "Debbie",
        "lastName": "Von Ahrens",
        "email": "debbievonahrens@mac.com"
      }
    ]
  }'
```

### Outbound send controls
- `windowHours`: eligibility window before appointment (default `6`).
- `sendTimezone`: timezone for send-hour guardrail (default `America/New_York`).
- `sendStartHour` / `sendEndHour`: allowed send range in 24h format (`9` to `17` = 9:00 AM to 4:59 PM).
- `enforceSendWindow`: set `false` to bypass send-hour guardrail for QA-only checks.
- `queueWhenOutsideWindow` (default `true`): if outside send hours, queue candidates for next send window instead of dropping them.
- `processQueued` (default `true`): when in-window, automatically drain due queued items and process them.
- `useQueuedOnly` (default `false`): process only queued items (no direct candidates required).
- `maxQueueDrain`: cap number of queued items processed in one run.
