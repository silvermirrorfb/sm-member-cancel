import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// PR-C: the cron's error accounting must not lie.
// (a) gate-infrastructure failures (klaviyo_lookup_error, klaviyo_profile_overflow,
//     lookup_failed) count as ERRORS, not skips, so a full consent-gate outage trips
//     the existing 2+ errors alert instead of reporting a healthy run.
// (b) a thrown per-candidate exception is caught, logged at error level with
//     candidate context (no new PII), counted as an error, and the run continues.
// (c) every results row is tallied, not just results[0].

const scanAppointments = vi.fn();
const getRegistryCounts = vi.fn(async () => ({}));
const sendOpsAlertEmail = vi.fn(async () => ({ sent: true }));
const redisSet = vi.fn();
function RedisCtor() { return { set: redisSet }; }
const RedisMock = vi.fn(RedisCtor);

vi.mock('../src/lib/boulevard.js', () => ({
  scanAppointments,
  getBoulevardAuthContext: () => ({ apiUrl: 'https://blvd.test/graphql', headers: { 'x-test': '1' } }),
  canonicalizeBoulevardLocationId: (x) => String(x || ''),
  resolveBoulevardLocationInput: (x) => ({ locationId: String(x || ''), canonicalId: String(x || ''), locationName: String(x || '') }),
}));

vi.mock('../src/lib/sms-member-registry.js', () => ({ getRegistryCounts }));

vi.mock('../src/lib/sms-window.js', () => ({
  isWithinSendWindow: () => ({ allowed: true, timeZone: 'America/New_York', hour: 13, startHour: 9, endHour: 19 }),
  getNextWindowStartIso: () => new Date().toISOString(),
}));

vi.mock('../src/lib/notify.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendOpsAlertEmail };
});

vi.mock('@upstash/redis', () => ({ Redis: RedisMock }));

function future(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function candidate(id, over = {}) {
  return {
    id,
    clientId: `c${id}`,
    clientFirstName: 'Test',
    clientLastName: `Member${id}`,
    clientEmail: `t${id}@example.com`,
    clientPhone: `+1555000${id}${id}${id}${id}`,
    locationId: 'Bryant Park',
    startOn: future(2),
    ...over,
  };
}

function scanReturning(appts) {
  return async (_url, _headers, ctx) => (String(ctx.locationId).includes('Bryant') ? { appointments: appts } : { appointments: [] });
}

async function loadRoute() {
  vi.resetModules();
  return import('../src/app/api/cron/sms-upgrade-scan/route.js');
}

describe('GET /api/cron/sms-upgrade-scan — honest error accounting', () => {
  let realFetch;
  let errorSpy;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.CRON_SECRET = '';
    process.env.SMS_CRON_ENABLED = 'true';
    process.env.SMS_CRON_LOCATIONS = 'Bryant Park,Flatiron';
    delete process.env.SMS_CRON_LOCATIONS_PER_RUN;
    delete process.env.SMS_CRON_MAX_CANDIDATES;
    delete process.env.SMS_AUTOMATION_BASE_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    scanAppointments.mockReset();
    getRegistryCounts.mockClear();
    sendOpsAlertEmail.mockClear();
    redisSet.mockReset();
    RedisMock.mockClear();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    errorSpy.mockRestore();
  });

  it('(a) classifies a klaviyo_lookup_error as an error, not a skip', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1')]));
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'skipped', reason: 'klaviyo_lookup_error' }] }) }));

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.skipped).toBe(0);
    expect(body.summary.errorsByReason).toEqual({ klaviyo_lookup_error: 1 });
    expect(body.summary.skippedByReason).toEqual({});
  });

  it('(a) a full consent-gate outage (two gate failures) trips the 2+ errors alert', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1'), candidate('2')]));
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      const reason = n === 1 ? 'klaviyo_lookup_error' : 'klaviyo_profile_overflow';
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'skipped', reason }] }) };
    });

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(2);
    expect(body.summary.skipped).toBe(0);
    expect(body.summary.errorsByReason).toEqual({ klaviyo_lookup_error: 1, klaviyo_profile_overflow: 1 });
    // 2+ errors must fire the ops alert.
    expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('(a) a legitimate not-subscribed decision stays a skip (no over-classification)', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1')]));
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'skipped', reason: 'klaviyo_sms_not_subscribed' }] }) }));

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(0);
    expect(body.summary.skipped).toBe(1);
    expect(body.summary.skippedByReason).toEqual({ klaviyo_sms_not_subscribed: 1 });
  });

  it('(b) one throwing candidate does not abort the run, increments errors, and logs at error level', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1'), candidate('2')]));
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('socket hang up');
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'sent' }] }) };
    });

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // run did not abort after the throw
    expect(body.summary.sent).toBe(1);
    expect(body.summary.errors).toBe(1);
    expect(body.summary.errorsByReason).toEqual({ 'socket hang up': 1 });
    // Pin the per-candidate catch log specifically (not the summary error line):
    // it must carry the candidate-context marker, the swallowed detail, the
    // non-PII identifiers, and NONE of the member's name/email/phone.
    const threwCall = errorSpy.mock.calls.find(
      args => String(args[0] || '').includes('[sms-upgrade-scan] candidate evaluation threw'),
    );
    expect(threwCall).toBeTruthy();
    const threwPayload = String(threwCall[1] || '');
    expect(threwPayload).toContain('socket hang up');
    expect(threwPayload).toContain('c1');            // clientId
    expect(threwPayload).toContain('Bryant Park');   // location name
    // No PII in the log line.
    expect(threwPayload).not.toContain('Member1');        // last name
    expect(threwPayload).not.toContain('t1@example.com'); // email
    expect(threwPayload).not.toContain('5550001111');     // phone digits
  });

  it('(a) classifies lookup_failed as an error too (the third gate-infra reason)', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1')]));
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'skipped', reason: 'lookup_failed' }] }) }));

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.skipped).toBe(0);
    expect(body.summary.errorsByReason).toEqual({ lookup_failed: 1 });
  });

  it('(a) a mixed run separates a gate failure (error) from a legitimate not-subscribed (skip)', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1'), candidate('2')]));
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      const reason = n === 1 ? 'klaviyo_lookup_error' : 'klaviyo_sms_not_subscribed';
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'skipped', reason }] }) };
    });

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.skipped).toBe(1);
    expect(body.summary.errorsByReason).toEqual({ klaviyo_lookup_error: 1 });
    expect(body.summary.skippedByReason).toEqual({ klaviyo_sms_not_subscribed: 1 });
    // One error is below the 2+ threshold, so no alert.
    expect(sendOpsAlertEmail).not.toHaveBeenCalled();
  });

  it('(b) an http error captures the response body into the error log to name the root cause', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1')]));
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom: boulevard timeout', json: async () => ({}) }));

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.errorsByReason).toEqual({ http_500: 1 });
    const failedCall = errorSpy.mock.calls.find(
      args => String(args[0] || '').includes('[sms-upgrade-scan] candidate request failed'),
    );
    expect(failedCall).toBeTruthy();
    const failedPayload = String(failedCall[1] || '');
    expect(failedPayload).toContain('boom: boulevard timeout');
    expect(failedPayload).toContain('c1'); // non-PII candidate context
  });

  it('(c) tallies every results row, not just results[0]', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1')]));
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, results: [
        { status: 'skipped', reason: 'no_upgrade_target_for_duration' },
        { status: 'sent', offerKind: 'duration' },
      ] }),
    }));

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.candidateCount).toBe(1);
    expect(body.summary.total).toBe(2); // both rows tallied, not just results[0]
    expect(body.summary.sent).toBe(1);
    expect(body.summary.skipped).toBe(1);
    expect(body.summary.skippedByReason).toEqual({ no_upgrade_target_for_duration: 1 });
  });

  it('(c) an empty results array surfaces as an error, not a silent unknown skip', async () => {
    scanAppointments.mockImplementation(scanReturning([candidate('1')]));
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [] }) }));

    const { GET } = await loadRoute();
    const body = await (await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'))).json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.skipped).toBe(0);
    expect(body.summary.errorsByReason).toEqual({ no_result_rows: 1 });
  });
});
