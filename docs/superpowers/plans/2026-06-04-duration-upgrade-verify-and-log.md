# Duration-Upgrade Verify-and-Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a successful duration-upgrade YES verified true in Boulevard before the member is told "you're all set," and make that sent confirmation visible in the SMS log, as one coupled change.

**Architecture:** Add a read-back step inside `reverifyAndApplyUpgradeForProfile` so the duration path only returns `success: true` after re-fetching the appointment and confirming its service now equals the configured target service id. If the read-back cannot confirm the change, return non-success so the existing webhook fail-closed routing sends "our team will confirm" and queues an ops incident. Separately, add `direction:'outbound'` logging at the two upgrade-reply sites in the webhook so a sent confirmation is recorded.

**Tech Stack:** Next.js App Router route handler, Boulevard Admin GraphQL, Vitest, Twilio TwiML webhook reply.

---

## Resolved Questions (read-only, answered before any change)

### Q1. What appointment-fetch already exists, and can the read-back reuse it?

`fetchAppointmentContextById(apiUrl, headers, appointmentId)` in `src/lib/boulevard.js:2587-2643` already exists and is already used by `reverifyAndApplyUpgradeForProfile` at `:3078-3080`. Its query:

```graphql
query FetchAppointmentContext($id: ID!) {
  appointment(id: $id) {
    id
    clientId
    locationId
    startAt
    endAt
    <notes fields>
    appointmentServices {
      id
      serviceId
      staffId
    }
  }
}
```

It returns (`:2626-2642`):
- `serviceId` — the primary appointment service's `serviceId` (`:2634`)
- `appointmentServices: [{ id, serviceId, staffId }]` (`:2635-2641`)

It returns the **service id** of the appointment's service(s), which is exactly what the upgrade mutation sets. It does **not** return a duration number. The read-back can **reuse this function as-is**; no new or extended query is needed. We verify by service id, not by duration.

### Q2. What is the upgrade-target representation we compare against?

In the duration path of `reverifyAndApplyUpgradeForProfile` (`:3225-3231`), the target is resolved to a **service id from env**:

```js
const targetDuration = Number(fresh.targetDurationMinutes);
const serviceId =
  targetDuration === 50 ? process.env.BOULEVARD_SERVICE_ID_50MIN
  : targetDuration === 90 ? process.env.BOULEVARD_SERVICE_ID_90MIN
  : null;
```

That same `serviceId` is what the mutation writes (`:3241`, `updateAppointment(input: { id, serviceId })`). So the exact field to verify post-mutation is: **does the re-fetched appointment now carry a service whose `serviceId` equals this `serviceId`** (the configured 50-minute or 90-minute service id). Duration is implied by the env mapping; comparing service ids is the precise, already-available check.

### Q3. Is the existing fail-closed destination reusable for "could not verify"?

Yes. The webhook routes any non-success upgrade result to the safe path automatically:
- `buildUpgradeApplyReply` (`src/app/api/sms/twilio/webhook/route.js:192-198`) returns `buildPendingOfferFinalizeReply(...)` ("our team will confirm") whenever `upgradeResult.success` is not truthy.
- `shouldQueueUpgradeFollowupIncident` (`:200-205`) returns `true` whenever `upgradeResult.success !== true`, which queues the ops incident via `queueSupportIncident` (`:207-211`).

So if the read-back returns `{ success: false, reason: 'upgrade_verification_failed' }`, the member gets the manual-confirmation copy and an incident is queued, with **no code change required in the webhook routing** for the failure case. The read-back is read-only, so the member's appointment is never mutated by the verification itself.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `__tests__/boulevard-duration-upgrade-verify.test.js` | Create | Reverify-level regression: mutation returns an id but service is unchanged -> non-success `upgrade_verification_failed`; mutation returns an id and service now equals target -> success `applied`. |
| `src/lib/boulevard.js` | Modify | Add `verifyAppointmentServiceApplied()` helper; gate the duration success return on it. |
| `__tests__/twilio-webhook-route.test.js` | Modify | Route-level regression: verified success -> "you're all set" plus an outbound log row; unverified -> "our team will confirm" plus incident plus no false success. |
| `src/app/api/sms/twilio/webhook/route.js` | Modify | Add `direction:'outbound'` logging at the two upgrade-reply sites. |

### Scope decision: outbound logging breadth

**Recommended (tighter scope):** add outbound logging only at the two upgrade-reply return sites (`:752-758` pending-offer YES, `:810-816` generic YES). Do **not** add outbound logging to the decline, pending-hold, web-handoff, or no-opportunity branches in this PR. That would be a route-wide logging refactor (a separate concern) and is not what the silent-success bug requires.

Note: those two sites are shared by duration and add-on YES replies, so this records add-on confirmations too. That is incidental observability at a shared reply site; it does **not** change any add-on apply logic, so it stays inside this PR's scope. The read-back behavior change in this PR is duration-only.

---

## Reference Notes

- The mutation only selects `appointment { id }` back (`src/lib/boulevard.js:2553`, `:2563`), so the mutation response alone cannot confirm the service changed. A separate read-back fetch is mandatory.
- `verifyAppointmentServiceApplied` biases to safety: if the re-fetch errors transiently (network, GraphQL error, null appointment, missing `appointmentServices`), it returns `false`, so the member is told "our team will confirm" and an incident is queued. That is a safe false-negative (never a false "you're all set"). This tradeoff is intentional, and Task 1 covers the error path explicitly.
- **What this verifies, precisely:** that the appointment now carries the env-configured target service id (`BOULEVARD_SERVICE_ID_50MIN` / `_90MIN`). It confirms "the mutation did what we told it." It does NOT independently confirm that the configured service id is actually a 50-minute service; if that env var is mapped to the wrong Boulevard service, both the mutation and the read-back use the same wrong id, so a false "all set" is still possible. That is a pre-existing config risk, not introduced here, and is strictly better than today's zero verification. Catching env misconfiguration belongs in a boot-time validation step (see TODO), not in this per-request path, so this PR does not add a second `fetchServiceContextById` round-trip.
- **Why the outbound log is awaited, not fire-and-forget:** on Vercel the function can suspend once the TwiML response is returned, so a fire-and-forget `logSmsChatMessages` would risk dropping the exact row we are adding. The existing inbound log at `:575` is already awaited, so awaiting the outbound log is the consistent, write-guaranteeing choice. It adds one sheet append to the reply path (latency cost, well under the Twilio webhook timeout). If webhook latency ever becomes a concern, the correct fix is to move BOTH sheet writes onto `waitUntil`/`after` so they complete after the response without blocking or being suspended; that is a separate performance PR (see TODO), not this one.
- Existing webhook tests do not assert `mockLogSmsChatMessages` call counts (`__tests__/twilio-webhook-route.test.js:23,65,109`), so adding outbound logging will not break them.

---

### Task 1: Reverify Read-Back Regression Test

**Files:**
- Create: `__tests__/boulevard-duration-upgrade-verify.test.js`

- [ ] **Step 1: Write the failing read-back tests**

Create `__tests__/boulevard-duration-upgrade-verify.test.js` with this content. The harness mirrors the known-good duration harness in `__tests__/boulevard-cancel-rebook-notes.test.js`, with two differences: the `UpgradeAppointment` mutation now succeeds (returns `appointment { id }`), and `FetchAppointmentContext` returns the pre-upgrade service id before the mutation and a test-controlled service id after it.

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = process.env;
const originalFetch = global.fetch;

function json(payload) {
  return { ok: true, json: async () => payload };
}

// Builds a fetch mock for the duration reverify path. `postMutationServiceId`
// is the serviceId FetchAppointmentContext reports AFTER the mutation runs
// (the read-back). Before the mutation it always reports 'svc-30'.
function buildFetch(postMutationServiceId) {
  let mutationApplied = false;
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query || '');
    const typeName = String(body?.variables?.typeName || '');

    if (query.includes('IntrospectType(')) {
      if (typeName === 'Query') {
        return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
      }
      if (typeName === 'Appointment') {
        return json({
          data: {
            __type: {
              fields: [
                { name: 'id' },
                { name: 'startOn' },
                { name: 'endOn' },
                { name: 'clientId' },
                { name: 'providerId' },
                { name: 'locationId' },
                { name: 'status' },
                { name: 'canceledAt' },
              ],
            },
          },
        });
      }
    }

    if (query.includes('IntrospectTypeDetailed')) {
      if (typeName === 'Appointment') {
        return json({
          data: {
            __type: {
              fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }],
            },
          },
        });
      }
      if (typeName === 'Query') {
        return json({
          data: {
            __type: {
              fields: [
                {
                  name: 'appointments',
                  args: [
                    { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                    { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                  ],
                  type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
                },
              ],
            },
          },
        });
      }
    }

    if (query.includes('FetchAppointmentContext')) {
      const currentServiceId = mutationApplied ? postMutationServiceId : 'svc-30';
      return json({
        data: {
          appointment: {
            id: 'appt-1',
            clientId: 'client-1',
            locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
            startAt: '2026-06-04T14:00:00.000Z',
            endAt: '2026-06-04T14:30:00.000Z',
            notes: 'Original internal note',
            appointmentServices: [{ id: 'aps-1', serviceId: currentServiceId, staffId: 'prov-1' }],
          },
        },
      });
    }

    if (query.includes('ScanAppointments')) {
      return json({
        data: {
          appointments: {
            edges: [
              {
                node: {
                  id: 'appt-1',
                  clientId: 'client-1',
                  providerId: 'prov-1',
                  locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                  startOn: '2026-06-04T14:00:00.000Z',
                  endOn: '2026-06-04T14:30:00.000Z',
                  status: 'BOOKED',
                  canceledAt: null,
                },
              },
              {
                node: {
                  id: 'appt-next',
                  clientId: 'other',
                  providerId: 'prov-1',
                  locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
                  startOn: '2026-06-04T15:10:00.000Z',
                  endOn: '2026-06-04T15:40:00.000Z',
                  status: 'BOOKED',
                  canceledAt: null,
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (query.includes('mutation UpgradeAppointment') || query.includes('mutation UpgradeAppointmentAlt')) {
      mutationApplied = true;
      return json({ data: { updateAppointment: { appointment: { id: 'appt-1' } } } });
    }

    return json({ data: {} });
  });
  return fetchMock;
}

describe('duration upgrade read-back verification', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      BOULEVARD_API_KEY: 'key',
      BOULEVARD_API_SECRET: Buffer.from('secret').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'biz-id',
      BOULEVARD_API_URL: 'https://dashboard.boulevard.io/api/2020-01/admin',
      BOULEVARD_SERVICE_ID_50MIN: 'svc-50',
      BOULEVARD_ENABLE_UPGRADE_MUTATION: 'true',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns non-success when the mutation reports an id but the service did not change', async () => {
    global.fetch = buildFetch('svc-30'); // read-back still shows the old 30-min service
    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('upgrade_verification_failed');
  });

  it('returns success only after the read-back confirms the target service is applied', async () => {
    global.fetch = buildFetch('svc-50'); // read-back shows the upgraded 50-min service
    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(true);
    expect(result.reason).toBe('applied');
    expect(result.updatedAppointmentId).toBe('appt-1');
  });

  it('fails closed when the read-back fetch errors after the mutation', async () => {
    // The mutation succeeds, but the post-mutation read-back returns a GraphQL
    // error. fetchAppointmentContextById turns that into null, so the verifier
    // must return false and the upgrade must NOT be reported as applied.
    let mutationApplied = false;
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      const typeName = String(body?.variables?.typeName || '');

      if (query.includes('IntrospectType(')) {
        if (typeName === 'Query') return json({ data: { __type: { fields: [{ name: 'appointments' }] } } });
        if (typeName === 'Appointment') {
          return json({
            data: {
              __type: {
                fields: [
                  { name: 'id' }, { name: 'startOn' }, { name: 'endOn' }, { name: 'clientId' },
                  { name: 'providerId' }, { name: 'locationId' }, { name: 'status' }, { name: 'canceledAt' },
                ],
              },
            },
          });
        }
      }
      if (query.includes('IntrospectTypeDetailed')) {
        if (typeName === 'Appointment') {
          return json({ data: { __type: { fields: [{ name: 'notes', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] } } });
        }
        if (typeName === 'Query') {
          return json({
            data: {
              __type: {
                fields: [{
                  name: 'appointments',
                  args: [
                    { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                    { name: 'after', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                  ],
                  type: { kind: 'OBJECT', name: 'AppointmentConnection', ofType: null },
                }],
              },
            },
          });
        }
      }
      if (query.includes('FetchAppointmentContext')) {
        // After the mutation, the read-back fetch errors out.
        if (mutationApplied) return json({ errors: [{ message: 'Boulevard read-back timeout' }] });
        return json({
          data: {
            appointment: {
              id: 'appt-1',
              clientId: 'client-1',
              locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa',
              startAt: '2026-06-04T14:00:00.000Z',
              endAt: '2026-06-04T14:30:00.000Z',
              notes: 'Original internal note',
              appointmentServices: [{ id: 'aps-1', serviceId: 'svc-30', staffId: 'prov-1' }],
            },
          },
        });
      }
      if (query.includes('ScanAppointments')) {
        return json({
          data: {
            appointments: {
              edges: [
                { node: { id: 'appt-1', clientId: 'client-1', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T14:00:00.000Z', endOn: '2026-06-04T14:30:00.000Z', status: 'BOOKED', canceledAt: null } },
                { node: { id: 'appt-next', clientId: 'other', providerId: 'prov-1', locationId: 'urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa', startOn: '2026-06-04T15:10:00.000Z', endOn: '2026-06-04T15:40:00.000Z', status: 'BOOKED', canceledAt: null } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (query.includes('mutation UpgradeAppointment') || query.includes('mutation UpgradeAppointmentAlt')) {
        mutationApplied = true;
        return json({ data: { updateAppointment: { appointment: { id: 'appt-1' } } } });
      }
      return json({ data: {} });
    });

    vi.resetModules();
    const { reverifyAndApplyUpgradeForProfile, __resetBoulevardCachesForTests } = await import('../src/lib/boulevard.js');
    __resetBoulevardCachesForTests();

    const result = await reverifyAndApplyUpgradeForProfile(
      { clientId: 'client-1', tier: '30', accountStatus: 'ACTIVE' },
      { appointmentId: 'appt-1', targetDurationMinutes: 50 },
      { now: '2026-06-04T12:00:00.000Z', windowHours: 6 },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe('upgrade_verification_failed');
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails before the fix**

Run:

```bash
npx vitest run __tests__/boulevard-duration-upgrade-verify.test.js
```

Expected before implementation: the first test FAILS, because today `reverifyAndApplyUpgradeForProfile` returns `{ success: true, reason: 'applied' }` on a bare mutation id with no read-back, so `result.success` is `true` and `result.reason` is `applied` instead of `upgrade_verification_failed`.

- [ ] **Step 3: Commit the failing test**

```bash
git add __tests__/boulevard-duration-upgrade-verify.test.js
git commit -m "test(sms): prove duration upgrade success requires a verified read-back"
```

---

### Task 2: Add Read-Back Verification in `boulevard.js`

**Files:**
- Modify: `src/lib/boulevard.js`
- Test: `__tests__/boulevard-duration-upgrade-verify.test.js`

- [ ] **Step 1: Add the `verifyAppointmentServiceApplied` helper**

In `src/lib/boulevard.js`, immediately after `tryApplyAppointmentUpgradeMutation` (ends at `:2585`) and before `fetchAppointmentContextById` (`:2587`), add:

```js
// Read-back guard: the upgrade mutation only echoes back appointment { id },
// so a Boulevard no-op can still look "applied". Re-fetch the appointment and
// confirm its service now equals the configured target service id before we
// treat the upgrade as real. Any fetch failure returns false (fail closed).
async function verifyAppointmentServiceApplied(apiUrl, headers, appointmentId, expectedServiceId) {
  const expected = String(expectedServiceId || '').trim();
  if (!expected) return false;
  const context = await fetchAppointmentContextById(apiUrl, headers, appointmentId);
  if (!context) return false;
  if (String(context.serviceId || '').trim() === expected) return true;
  return (context.appointmentServices || []).some(
    service => String(service?.serviceId || '').trim() === expected,
  );
}
```

- [ ] **Step 2: Gate the duration success return on the read-back**

In `reverifyAndApplyUpgradeForProfile`, replace the current success block (`src/lib/boulevard.js:3241-3258`):

```js
  const applied = await tryApplyAppointmentUpgradeMutation(auth.apiUrl, auth.headers, fresh.appointmentId, serviceId);
  if (!applied.applied) {
    return {
      success: false,
      reason: applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }

  return {
    success: true,
    reason: 'applied',
    reverified: true,
    opportunity: fresh,
    mutationRoot: applied.mutationRoot,
    updatedAppointmentId: applied.updatedId,
  };
}
```

with:

```js
  const applied = await tryApplyAppointmentUpgradeMutation(auth.apiUrl, auth.headers, fresh.appointmentId, serviceId);
  if (!applied.applied) {
    return {
      success: false,
      reason: applied.reason || 'upgrade_mutation_failed',
      reverified: true,
      opportunity: fresh,
    };
  }

  const verified = await verifyAppointmentServiceApplied(
    auth.apiUrl,
    auth.headers,
    fresh.appointmentId,
    serviceId,
  );
  if (!verified) {
    return {
      success: false,
      reason: 'upgrade_verification_failed',
      reverified: true,
      opportunity: fresh,
      mutationRoot: applied.mutationRoot,
      updatedAppointmentId: applied.updatedId,
    };
  }

  return {
    success: true,
    reason: 'applied',
    reverified: true,
    opportunity: fresh,
    mutationRoot: applied.mutationRoot,
    updatedAppointmentId: applied.updatedId,
  };
}
```

- [ ] **Step 3: Run the read-back test and verify it passes**

Run:

```bash
npx vitest run __tests__/boulevard-duration-upgrade-verify.test.js
```

Expected after implementation: PASS (both tests).

- [ ] **Step 4: Run the existing duration safety tests to confirm no regression**

Run:

```bash
npx vitest run __tests__/boulevard-cancel-rebook-notes.test.js __tests__/boulevard-duration-upgrade-append-safety.test.js
```

Expected: PASS. The cancel-rebook test mutation still fails, so it returns before the read-back; the read-back only runs after a successful mutation.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/lib/boulevard.js
git commit -m "fix(sms): verify duration upgrade applied via read-back before success"
```

---

### Task 3: Route-Level Outbound-Log + Failure-Routing Test

**Files:**
- Modify: `__tests__/twilio-webhook-route.test.js`

- [ ] **Step 1: Add two webhook tests near the existing duration upgrade tests**

Append these tests inside the `describe('twilio webhook route', ...)` block (for example right after the test titled `'uses pending-offer appointment for YES instead of fresh generic opportunity evaluation'`):

```js
  it('logs an outbound confirmation row when a verified upgrade succeeds', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-verify-1',
        targetDurationMinutes: 50,
        currentDurationMinutes: 30,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-verify-ok',
    });

    const res = await POST(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("You're all set. See you soon.");
    const outboundCalls = mockLogSmsChatMessages.mock.calls
      .flatMap(call => call[0])
      .filter(row => row && row.direction === 'outbound');
    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0]).toMatchObject({
      direction: 'outbound',
      outcome: 'upgrade_confirmed',
    });
    expect(outboundCalls[0].content).toContain("You're all set");
  });

  it('does not claim success and queues follow-up when the upgrade cannot be verified', async () => {
    const session = {
      id: 'sess-1',
      status: 'active',
      smsInboundCount: 0,
      memberProfile: { clientId: 'client-1', phone: '+12134401333' },
      pendingUpgradeOffer: {
        offerKind: 'duration',
        appointmentId: 'appt-verify-2',
        targetDurationMinutes: 50,
        currentDurationMinutes: 30,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({
      success: false,
      reason: 'upgrade_verification_failed',
      reverified: true,
      opportunity: {
        appointmentId: 'appt-verify-2',
        currentDurationMinutes: 30,
        targetDurationMinutes: 50,
        pricing: { walkinDelta: 50, walkinTotal: 169 },
      },
    });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-verify-fail',
    });

    const res = await POST(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain("You're all set");
    expect(text).toContain('Our team will confirm before your appointment.');
    expect(session.pendingUpgradeOffer).toBeNull();
    expect(mockLogSupportIncident).toHaveBeenCalledTimes(1);
    expect(mockLogSupportIncident.mock.calls[0][0]).toMatchObject({
      issue_type: 'sms_upgrade_manual_followup',
      reason: 'upgrade_verification_failed',
    });
    const outboundCalls = mockLogSmsChatMessages.mock.calls
      .flatMap(call => call[0])
      .filter(row => row && row.direction === 'outbound');
    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0]).toMatchObject({ direction: 'outbound', outcome: 'manual_followup' });
  });

  it('logs an outbound row on the generic YES branch (no pending offer)', async () => {
    // This exercises the SECOND reply site (route.js :810-816), reached when
    // there is no pending offer but a fresh eligible opportunity is found.
    // Without this test the generic-branch logging could be omitted and the
    // pending-offer tests would still pass.
    const session = { id: 'sess-1', status: 'active', smsInboundCount: 0 };
    mockGetSessionIdForPhone.mockReturnValue('sess-1');
    mockGetSession.mockReturnValue(session);
    mockLookupMember.mockResolvedValue({
      clientId: 'client-1',
      phone: '+12134401333',
      tier: '30',
      accountStatus: 'ACTIVE',
    });
    mockEvaluateUpgradeOpportunityForProfile.mockResolvedValue({
      eligible: true,
      appointmentId: 'appt-generic-1',
      currentDurationMinutes: 30,
      targetDurationMinutes: 50,
      pricing: { walkinDelta: 50, walkinTotal: 169 },
    });
    mockReverifyAndApplyUpgradeForProfile.mockResolvedValue({ success: true, reason: 'applied' });

    const req = new Request('https://sm-member-cancel.vercel.app/api/sms/twilio/webhook', {
      method: 'POST',
      headers: { 'x-twilio-signature': 'sig' },
      body: 'From=%2B12134401333&Body=Yes&MessageSid=SM-in-generic-ok',
    });

    const res = await POST(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("You're all set. See you soon.");
    const outboundCalls = mockLogSmsChatMessages.mock.calls
      .flatMap(call => call[0])
      .filter(row => row && row.direction === 'outbound');
    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0]).toMatchObject({ direction: 'outbound', outcome: 'upgrade_confirmed' });
  });
```

Note: if `isSmsDurationOfferAllowed(opportunity)` (route.js `:762`) rejects this mocked opportunity before reaching the reply site, mirror the opportunity shape used by the existing `'logs support follow-up when apply succeeds but notes sync fails'` test (`__tests__/twilio-webhook-route.test.js:255-300`), which already reaches `:810-816` successfully.

- [ ] **Step 2: Run the webhook tests and verify the new ones fail**

Run:

```bash
npx vitest run __tests__/twilio-webhook-route.test.js
```

Expected before implementation: the two new tests FAIL, because no outbound row is logged yet (`outboundCalls` is empty). The `"You're all set"` and incident assertions already hold; only the outbound-log assertions fail.

- [ ] **Step 3: Commit the failing tests**

```bash
git add __tests__/twilio-webhook-route.test.js
git commit -m "test(sms): require an outbound log row on duration upgrade YES replies"
```

---

### Task 4: Add Outbound Logging at the Upgrade-Reply Sites

**Files:**
- Modify: `src/app/api/sms/twilio/webhook/route.js`
- Test: `__tests__/twilio-webhook-route.test.js`

- [ ] **Step 1: Add a small outbound-logging helper**

In `src/app/api/sms/twilio/webhook/route.js`, immediately after `queueSupportIncident` (`:207-211`), add:

```js
async function logUpgradeReplyOutbound({ sessionId, from, activeSession, offer, upgradeResult, content }) {
  try {
    await logSmsChatMessages([{
      sessionId,
      timestamp: new Date().toISOString(),
      direction: 'outbound',
      phone: from,
      memberName: activeSession?.memberProfile?.name || null,
      location: activeSession?.memberProfile?.locationName || null,
      content,
      offerType: offer?.offerKind || null,
      outcome: upgradeResult?.success === true ? 'upgrade_confirmed' : 'manual_followup',
    }]);
  } catch (err) {
    console.error('SMS outbound upgrade reply logging failed:', err);
  }
}
```

- [ ] **Step 2: Log the pending-offer YES reply**

In the pending-offer YES branch, the current block is `src/app/api/sms/twilio/webhook/route.js:752-758`:

```js
          const upgradeText = buildUpgradeApplyReply(upgradeResult, upgradeResult?.opportunity || null, pendingOffer);
          const upgradeTwiml = buildTwimlMessage(upgradeText);
          if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
          return new NextResponse(upgradeTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
```

Insert the log call after `upgradeText` is built and before the `return`:

```js
          const upgradeText = buildUpgradeApplyReply(upgradeResult, upgradeResult?.opportunity || null, pendingOffer);
          const upgradeTwiml = buildTwimlMessage(upgradeText);
          if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
          await logUpgradeReplyOutbound({
            sessionId,
            from,
            activeSession,
            offer: pendingOffer,
            upgradeResult,
            content: upgradeText,
          });
          return new NextResponse(upgradeTwiml, {
            status: 200,
            headers: buildTwimlHeaders(rateLimit),
          });
```

- [ ] **Step 3: Log the generic YES reply**

In the generic YES branch, the current block is `src/app/api/sms/twilio/webhook/route.js:810-816`:

```js
        const upgradeText = buildUpgradeApplyReply(upgradeResult, opportunity, pendingOffer);
        const upgradeTwiml = buildTwimlMessage(upgradeText);
        if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
        return new NextResponse(upgradeTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
```

Insert the log call after `upgradeText` is built and before the `return`:

```js
        const upgradeText = buildUpgradeApplyReply(upgradeResult, opportunity, pendingOffer);
        const upgradeTwiml = buildTwimlMessage(upgradeText);
        if (messageSid) storeReplyForMessageSid(messageSid, upgradeTwiml);
        await logUpgradeReplyOutbound({
          sessionId,
          from,
          activeSession,
          offer: pendingOffer || opportunity,
          upgradeResult,
          content: upgradeText,
        });
        return new NextResponse(upgradeTwiml, {
          status: 200,
          headers: buildTwimlHeaders(rateLimit),
        });
```

- [ ] **Step 4: Run the webhook tests and verify they pass**

Run:

```bash
npx vitest run __tests__/twilio-webhook-route.test.js
```

Expected after implementation: PASS (all webhook tests, including the two new ones).

- [ ] **Step 5: Commit the implementation**

```bash
git add src/app/api/sms/twilio/webhook/route.js
git commit -m "fix(sms): log outbound duration upgrade YES confirmations"
```

---

### Task 5: Full Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run the focused suites**

Run:

```bash
npx vitest run __tests__/boulevard-duration-upgrade-verify.test.js __tests__/boulevard-cancel-rebook-notes.test.js __tests__/boulevard-duration-upgrade-append-safety.test.js __tests__/twilio-webhook-route.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the full suite**

Run:

```bash
npx vitest run
```

Expected: PASS (no previously green test regresses; full suite stays green).

- [ ] **Step 3: Confirm the coupled behavior at a glance**

Run:

```bash
rg -n "verifyAppointmentServiceApplied|upgrade_verification_failed" src/lib/boulevard.js
rg -n "logUpgradeReplyOutbound|direction: 'outbound'" src/app/api/sms/twilio/webhook/route.js
```

Expected: the read-back helper and reason exist in `boulevard.js`; the outbound logging helper and `direction:'outbound'` row exist at the two reply sites in the webhook.

---

### Task 6: Merge

**Files:**
- No code files.

- [ ] **Step 1: Open the PR and merge with a merge commit (not squash)**

The branch carries five commits (failing test, read-back impl, failing route test, outbound-log impl, plus this plan if committed). Merge with a merge commit so the test-then-implement history is preserved. No co-author trailers. No em dashes in the PR title or body.

---

## Self-Review

**Spec coverage:**
- Read-back verification before success: Task 2 (`verifyAppointmentServiceApplied`, gated success return). Covered.
- Non-success routes to "our team will confirm" + incident: relies on existing webhook routing (Q3), proven in Task 3 second test. Covered.
- Outbound logging on upgrade-reply branches: Task 4, scoped to the two reply sites only. Covered.
- Regression (i) unchanged duration -> non-success, not "you're all set": Task 1 first test (reverify) + Task 3 second test (route). Covered.
- Regression (ii) verified change -> "you're all set" + outbound log row: Task 1 second test + Task 3 first test. Covered.
- Regression (iii) appointment untouched on unverified path: the read-back is read-only and the duration mutation is in-place (no destructive call), so a no-op leaves the old service in place, which is exactly what the Task 1 first test asserts (read-back still reads `svc-30`). Covered.
- Full suite stays green: Task 5 Step 2. Covered.

**Placeholder scan:** None. Every step has concrete file paths, exact line ranges, full code, exact commands, and expected outcomes.

**Type consistency:**
- New reason string `upgrade_verification_failed` is used identically in `boulevard.js` (Task 2) and the route test (Task 3).
- Success reason stays `applied`; success shape (`mutationRoot`, `updatedAppointmentId`) is unchanged.
- Helper names match across tasks: `verifyAppointmentServiceApplied` (boulevard), `logUpgradeReplyOutbound` (route).
- Outbound log row uses `direction:'outbound'` and `outcome` of `upgrade_confirmed` (success) or `manual_followup` (non-success), asserted identically in Task 3.

**Scope lock:** Only the duration-upgrade confirmation, its read-back, and its outbound logging are touched. The add-on apply path, env/constant removal (PR C), and alert formatting are untouched.

---

## Eng-Review Outputs

### Data flow (after this change)

```
member texts YES
      |
      v
webhook route.js  (logs INBOUND row :575)
      |
      v
reverifyAndApplyUpgradeForProfile (boulevard.js)
      |
      |-- eligibility reverify (fresh)
      |-- updateAppointment(serviceId)  --> applied:true on any returned id
      |-- NEW: verifyAppointmentServiceApplied()
      |        re-fetch appointment, does a service == target serviceId?
      |          yes -> success:true  reason 'applied'
      |          no/err -> success:false reason 'upgrade_verification_failed'
      v
buildUpgradeApplyReply
   success -> "You're all set. See you soon."
   non-success -> "our team will confirm" + queueSupportIncident
      |
      v
NEW: logUpgradeReplyOutbound (OUTBOUND row, outcome upgrade_confirmed | manual_followup)
      |
      v
return TwiML  ->  Twilio sends the SMS
```

### What already exists (reused, not rebuilt)

- `fetchAppointmentContextById` (`boulevard.js:2587`) — reused as-is for the read-back. Returns `serviceId` + `appointmentServices[].serviceId`, exactly what we compare. No new query.
- Fail-closed routing — `buildUpgradeApplyReply` (`route.js:192`) and `shouldQueueUpgradeFollowupIncident` (`:200`) already send "our team will confirm" + queue an incident on any non-success. The read-back returning non-success reuses this with zero routing changes.
- `logSmsChatMessages` (`notify.js`) — already used for inbound rows; reused for the new outbound row.
- Duration reverify test harness — `__tests__/boulevard-cancel-rebook-notes.test.js` is the working template the Task 1 mock is modeled on.

### NOT in scope (considered and deferred)

- **Route-wide outbound logging** (decline `:723`, pending-hold `:631`, mutation-disabled finalize `:654`, web-handoff `:592`, no-opportunity `:782`). Deferred: those replies are not the silent-success bug; logging them is a separate logging-completeness PR.
- **Add-on read-back verification.** The add-on path already verifies through `bookingComplete` and is out of scope per the scope lock. (The outbound log at the shared reply site does incidentally record add-on YES replies; that is observability only, no behavior change.)
- **Boot-time env service-id validation** (assert `BOULEVARD_SERVICE_ID_50MIN`/`_90MIN` actually map to 50/90-minute services). Deferred to a TODO; it is config validation, not per-request verification.
- **Moving sheet writes to `waitUntil`/`after`.** Deferred to a performance PR; this PR keeps the existing awaited-write pattern.
- **Duration-based verification** (compare `fetchServiceContextById.defaultDuration` to the target). Deferred: adds a round-trip on the reply path; service-id equality is the precise check for "did the mutation do what we asked."

### Failure modes (new codepaths)

| Codepath | Realistic prod failure | Test? | Error handling? | Member sees |
| --- | --- | --- | --- | --- |
| `verifyAppointmentServiceApplied` | Boulevard read-back times out / GraphQL error after a real apply | Yes (Task 1, error test) | Yes — returns `false` (fail closed) | "our team will confirm" + ops incident (safe false-negative) |
| `verifyAppointmentServiceApplied` | Mutation no-op (id returned, service unchanged) | Yes (Task 1) | Yes — `false` | "our team will confirm" + incident |
| `logUpgradeReplyOutbound` | Sheet append throws | No direct test (try/catch swallows) | Yes — try/catch, logged to console | Reply still sends; row may be missing (best-effort) |
| `logUpgradeReplyOutbound` | Sheet append slow | No | Awaited; bounded by Twilio 15s timeout | Slight reply latency |

No critical gap: every new failure mode is either tested with error handling, or (the log) is best-effort and cannot break the member reply.

### TODOs surfaced (not built here)

1. **Boot-time env service-id validation.** Assert at startup that `BOULEVARD_SERVICE_ID_50MIN` / `_90MIN` resolve to services whose `defaultDuration` is 50 / 90. Why: the read-back trusts these ids; a misconfig produces a verified-but-wrong "all set." Where to start: `src/lib/validate-env.js` + `fetchServiceContextById`.
2. **Migrate webhook sheet writes to `waitUntil`/`after`.** Move the inbound (`:575`) and new outbound log off the awaited response path so they complete after the response without blocking or being suspended. Why: removes Sheets latency from the Twilio reply path while still guaranteeing the write. Depends on: confirming the Next.js `after()` API is available in this runtime.

### Cross-model tension (codex outside voice)

Codex recommended making the outbound log fire-and-forget to avoid blocking the Twilio response. Rejected: on Vercel the function can suspend after the response returns, dropping the exact row this PR adds. Awaiting (consistent with the existing inbound log at `:575`) guarantees the write; the latency concern is captured as the `waitUntil` TODO. The other four codex findings (generic-branch test, env-id trust, read-back error coverage, scope crispness) are folded into this plan.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_resolved | 5 findings (4 folded in, 1 rejected with rationale) |
| Outside Voice | `codex exec` | Independent 2nd opinion | 1 | issues_found | 5 findings, 4 accepted |

- **CODEX:** flagged generic-branch test gap, awaited-log latency, env-id over-trust, undertested read-back failure, scope crispness. 4 folded into the plan; fire-and-forget rejected (serverless suspend would drop the row).
- **CROSS-MODEL:** agreement on read-back correctness and the need for the verification; disagreement only on log await vs fire-and-forget (resolved in favor of await + `waitUntil` TODO).
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — plan is ready to implement. Scope is tight (2 source files, 2 test files, 0 new classes), tests cover both reply sites and the fail-closed error path, and the one real product tradeoff (fail-closed false-negatives on read-back error) is intentional and documented.
