import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../src/lib/sms-member-registry.js', () => ({
  getRegistryCounts,
}));

vi.mock('../src/lib/sms-window.js', () => ({
  isWithinSendWindow: () => ({ allowed: true, timeZone: 'America/New_York', hour: 13, startHour: 9, endHour: 19 }),
  getNextWindowStartIso: () => new Date().toISOString(),
}));

vi.mock('../src/lib/notify.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendOpsAlertEmail,
  };
});

vi.mock('@upstash/redis', () => ({
  Redis: RedisMock,
}));

function future(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function loadRoute() {
  vi.resetModules();
  return import('../src/app/api/cron/sms-upgrade-scan/route.js');
}

describe('GET /api/cron/sms-upgrade-scan (appointment-discovery mode)', () => {
  let realFetch;

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
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('builds candidates from scanned appointments, drops ones missing name/contact, and reports skippedByReason', async () => {
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
            { id: 'a2', clientId: 'c2', clientFirstName: 'Sam', clientLastName: 'Park', clientEmail: '', clientPhone: '+15553334444', locationId: 'Bryant Park', startOn: future(5) },
            // a3: no name and no contact → must be dropped before any send
            { id: 'a3', clientId: '', clientFirstName: '', clientLastName: '', clientEmail: '', clientPhone: '', locationId: 'Bryant Park', startOn: future(6) },
          ],
        };
      }
      return { appointments: [] };
    });

    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      const results = call === 1
        ? [{ status: 'sent', offerKind: 'addon' }]
        : [{ status: 'skipped', reason: 'klaviyo_sms_not_subscribed' }];
      return { ok: true, status: 200, json: async () => ({ ok: true, results }) };
    });

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.candidateCount).toBe(2); // a3 dropped
    expect(scanAppointments).toHaveBeenCalled();
    // each surviving candidate was POSTed to the pre-appointment endpoint
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(body.summary.total).toBe(2);
    expect(body.summary.sent).toBe(1);
    expect(body.summary.skipped).toBe(1);
    expect(body.summary.skippedByReason).toEqual({ klaviyo_sms_not_subscribed: 1 });
    expect(body.summary).toHaveProperty('errors', 0);
  });

  it('skips with no_appointments_in_window when no scanned appointment qualifies', async () => {
    scanAppointments.mockResolvedValue({ appointments: [] });
    globalThis.fetch = vi.fn();

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.skipped).toBe('no_appointments_in_window');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('honors SMS_CRON_ENABLED=false without scanning Boulevard', async () => {
    process.env.SMS_CRON_ENABLED = 'false';
    globalThis.fetch = vi.fn();

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();

    expect(body).toEqual({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });
    expect(scanAppointments).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('400s when SMS_CRON_LOCATIONS is empty', async () => {
    process.env.SMS_CRON_LOCATIONS = '';
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    expect(res.status).toBe(400);
  });

  it('dedupes appointments that resolve to the same client', async () => {
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'cdup', clientFirstName: 'Dana', clientLastName: 'Roe', clientEmail: 'd@example.com', clientPhone: '+15550001111', locationId: 'Bryant Park', startOn: future(2) },
            { id: 'a2', clientId: 'cdup', clientFirstName: 'Dana', clientLastName: 'Roe', clientEmail: 'd@example.com', clientPhone: '+15550001111', locationId: 'Bryant Park', startOn: future(8) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'sent' }] }) }));

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();
    expect(body.candidateCount).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses SMS_AUTOMATION_BASE_URL when set, ignoring the inbound request host', async () => {
    process.env.SMS_AUTOMATION_BASE_URL = 'https://override.example.com';
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'sent' }] }) }));

    const { GET } = await loadRoute();
    await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(globalThis.fetch.mock.calls[0][0]);
    expect(calledUrl).toBe('https://override.example.com/api/sms/automation/pre-appointment');
  });

  it('falls back to https://sm-member-cancel.vercel.app when SMS_AUTOMATION_BASE_URL is unset', async () => {
    delete process.env.SMS_AUTOMATION_BASE_URL;
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [{ status: 'sent' }] }) }));

    const { GET } = await loadRoute();
    await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(globalThis.fetch.mock.calls[0][0]);
    expect(calledUrl).toBe('https://sm-member-cancel.vercel.app/api/sms/automation/pre-appointment');
  });

  it('buckets HTTP 401 response as error with reason http_401', async () => {
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();

    expect(body.summary.sent).toBe(0);
    expect(body.summary.errors).toBe(1);
    expect(body.summary.errorsByReason).toEqual({ http_401: 1 });
    expect(body.summary.httpStatusCodes).toEqual({ '401': 1 });
  });

  it('buckets HTTP 500 response as error with reason http_500', async () => {
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.errorsByReason).toEqual({ http_500: 1 });
    expect(body.summary.httpStatusCodes).toEqual({ '500': 1 });
  });

  it('buckets non-JSON response as error with reason non_json_response', async () => {
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Unexpected token <'); },
    }));

    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    const body = await res.json();

    expect(body.summary.errors).toBe(1);
    expect(body.summary.errorsByReason).toEqual({ non_json_response: 1 });
  });

  it('fires inline alert once per hour when errors>=2', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://r.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';

    // Two candidates so the run produces errors=2, which meets the alert threshold.
    scanAppointments.mockImplementation(async (_url, _headers, ctx) => {
      if (String(ctx.locationId).includes('Bryant')) {
        return {
          appointments: [
            { id: 'a1', clientId: 'c1', clientFirstName: 'Katherine', clientLastName: 'Lee', clientEmail: 'k@example.com', clientPhone: '+15551112222', locationId: 'Bryant Park', startOn: future(2) },
            { id: 'a2', clientId: 'c2', clientFirstName: 'Sam', clientLastName: 'Park', clientEmail: 's@example.com', clientPhone: '+15553334444', locationId: 'Bryant Park', startOn: future(4) },
          ],
        };
      }
      return { appointments: [] };
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    // First SET NX wins (new condition key), second loses (same key on second run).
    redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const { GET } = await loadRoute();
    await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));
    await GET(new Request('https://app.test/api/cron/sms-upgrade-scan'));

    expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledTimes(2);
    const firstCall = redisSet.mock.calls[0];
    expect(firstCall[0]).toMatch(/^sms-alert:errors:/);
    expect(firstCall[2]).toEqual({ nx: true, ex: 3600 });
  });
});
