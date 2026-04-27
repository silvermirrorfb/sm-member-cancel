import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('GA4 Measurement Protocol fireGa4Event', () => {
  const originalEnv = process.env;
  let fetchSpy;

  async function load() {
    vi.resetModules();
    return import('../src/lib/ga4.js');
  }

  function makeFetchResponse({ status = 204, body = '' } = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => (body ? JSON.parse(body) : {}),
      clone() { return this; },
    };
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GA4_MEASUREMENT_ID: 'G-TESTID',
      GA4_API_SECRET: 'secret-xyz',
      GA4_DEBUG_MODE: 'false',
    };
    fetchSpy = vi.fn().mockResolvedValue(makeFetchResponse({ status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('credentials handling', () => {
    it('returns {ok:false, reason:"credentials_missing"} when GA4_MEASUREMENT_ID is absent', async () => {
      delete process.env.GA4_MEASUREMENT_ID;
      const { fireGa4Event } = await load();
      const result = await fireGa4Event('call_received', { location: 'brickell' });
      expect(result).toEqual({ ok: false, reason: 'credentials_missing' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns {ok:false, reason:"credentials_missing"} when GA4_API_SECRET is absent', async () => {
      delete process.env.GA4_API_SECRET;
      const { fireGa4Event } = await load();
      const result = await fireGa4Event('call_received', { location: 'brickell' });
      expect(result).toEqual({ ok: false, reason: 'credentials_missing' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns {ok:false, reason:"empty_event_name"} on empty event name', async () => {
      const { fireGa4Event } = await load();
      expect(await fireGa4Event('', {})).toEqual({ ok: false, reason: 'empty_event_name' });
      expect(await fireGa4Event(null, {})).toEqual({ ok: false, reason: 'empty_event_name' });
    });
  });

  describe('endpoint and request shape', () => {
    it('POSTs to the production endpoint with measurement_id and api_secret on the query string', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('call_received', { location: 'brickell', callSid: 'CA_1' });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toMatch(/^https:\/\/www\.google-analytics\.com\/mp\/collect\?/);
      expect(url).toContain('measurement_id=G-TESTID');
      expect(url).toContain('api_secret=secret-xyz');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('body contains client_id and a single event with params', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('call_received', { location: 'brickell', callSid: 'CA_1' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.client_id).toBeTruthy();
      expect(body.events).toHaveLength(1);
      expect(body.events[0].name).toBe('call_received');
    });
  });

  describe('PII handling', () => {
    it('never sends raw phone; replaces caller_phone with caller_phone_hash', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('callback_requested', { callerPhone: '+19175551234', location: 'brickell' });
      const raw = fetchSpy.mock.calls[0][1].body;
      expect(raw).not.toContain('+19175551234');
      expect(raw).not.toContain('9175551234');
      const body = JSON.parse(raw);
      expect(body.events[0].params.caller_phone_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(body.events[0].params).not.toHaveProperty('caller_phone');
      expect(body.events[0].params).not.toHaveProperty('callerPhone');
    });

    it('accepts snake_case caller_phone input identically', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('callback_requested', { caller_phone: '+19175551234' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.events[0].params.caller_phone_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(body.events[0].params).not.toHaveProperty('caller_phone');
    });

    it('derives stable client_id from phone (same phone → same id)', async () => {
      const { getClientId } = await load();
      const a = getClientId('+19175551234');
      const b = getClientId('+19175551234');
      const c = getClientId('+13055559999');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[a-f0-9]+\.[a-f0-9]+$/);
    });

    it('returns "anonymous" client_id when no phone is present', async () => {
      const { getClientId } = await load();
      expect(getClientId(null)).toBe('anonymous');
      expect(getClientId(undefined)).toBe('anonymous');
      expect(getClientId('')).toBe('anonymous');
    });
  });

  describe('parameter normalization', () => {
    it('maps location → location_name, callSid → call_sid, messageSid → message_sid', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('auto_text_sent', {
        location: 'brickell',
        callSid: 'CA_1',
        messageSid: 'SM_1',
        autotext_version: 'v1',
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const params = body.events[0].params;
      expect(params.location_name).toBe('brickell');
      expect(params.call_sid).toBe('CA_1');
      expect(params.message_sid).toBe('SM_1');
      expect(params).not.toHaveProperty('location');
      expect(params).not.toHaveProperty('callSid');
      expect(params).not.toHaveProperty('messageSid');
    });

    it('maps dialCallStatus → dial_call_status', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('call_missed', { location: 'brickell', dialCallStatus: 'no-answer' });
      const params = JSON.parse(fetchSpy.mock.calls[0][1].body).events[0].params;
      expect(params.dial_call_status).toBe('no-answer');
      expect(params).not.toHaveProperty('dialCallStatus');
    });

    it('renames reason → suppression_reason ONLY on auto_text_suppressed', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('auto_text_suppressed', { location: 'brickell', reason: 'cooldown' });
      const p1 = JSON.parse(fetchSpy.mock.calls[0][1].body).events[0].params;
      expect(p1.suppression_reason).toBe('cooldown');
      expect(p1).not.toHaveProperty('reason');
    });

    it('leaves reason alone on other events', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('callback_requested', { location: 'brickell', reason: 'informational' });
      const p1 = JSON.parse(fetchSpy.mock.calls[0][1].body).events[0].params;
      expect(p1.reason).toBe('informational');
      expect(p1).not.toHaveProperty('suppression_reason');
    });

    it('auto-adds time_of_day (0-23) and day_of_week (0-6)', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('call_received', { location: 'brickell' });
      const params = JSON.parse(fetchSpy.mock.calls[0][1].body).events[0].params;
      expect(params.time_of_day).toBeGreaterThanOrEqual(0);
      expect(params.time_of_day).toBeLessThanOrEqual(23);
      expect(params.day_of_week).toBeGreaterThanOrEqual(0);
      expect(params.day_of_week).toBeLessThanOrEqual(6);
    });

    it('does not overwrite caller-provided canonical keys', async () => {
      const { fireGa4Event } = await load();
      await fireGa4Event('call_received', {
        location_name: 'brickell',
        call_sid: 'CA_canonical',
        location: 'ignored',
        callSid: 'ignored',
      });
      const params = JSON.parse(fetchSpy.mock.calls[0][1].body).events[0].params;
      expect(params.location_name).toBe('brickell');
      expect(params.call_sid).toBe('CA_canonical');
    });
  });

  describe('debug mode', () => {
    it('sends to the /debug endpoint when GA4_DEBUG_MODE=true', async () => {
      process.env.GA4_DEBUG_MODE = 'true';
      const { fireGa4Event } = await load();
      await fireGa4Event('call_received', { location: 'brickell' });
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toMatch(/^https:\/\/www\.google-analytics\.com\/debug\/mp\/collect\?/);
    });

    it('logs validation warnings from the debug endpoint', async () => {
      process.env.GA4_DEBUG_MODE = 'true';
      fetchSpy.mockResolvedValue(makeFetchResponse({
        status: 200,
        body: JSON.stringify({
          validationMessages: [{ description: 'Unknown param foo', fieldPath: 'events[0].params.foo' }],
        }),
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { fireGa4Event } = await load();
      await fireGa4Event('call_received', { location: 'brickell', foo: 'bar' });
      const warnOutput = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(warnOutput).toMatch(/validation warnings/i);
      expect(warnOutput).toMatch(/Unknown param foo/);
    });
  });

  describe('error handling', () => {
    it('returns {ok:false, reason:"http_error", status} on non-2xx, non-204 response', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse({ status: 500, body: 'server error' }));
      const { fireGa4Event } = await load();
      const result = await fireGa4Event('call_received', { location: 'brickell' });
      expect(result).toEqual({ ok: false, reason: 'http_error', status: 500 });
    });

    it('returns {ok:false, reason:"exception"} when fetch itself throws', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const { fireGa4Event } = await load();
      const result = await fireGa4Event('call_received', { location: 'brickell' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('exception');
      expect(result.error).toMatch(/network down/);
    });

    it('treats 204 as success (GA4 normal response)', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse({ status: 204 }));
      const { fireGa4Event } = await load();
      const result = await fireGa4Event('call_received', { location: 'brickell' });
      expect(result).toEqual({ ok: true });
    });

    it('treats 200 as success (debug endpoint response)', async () => {
      process.env.GA4_DEBUG_MODE = 'true';
      fetchSpy.mockResolvedValue(makeFetchResponse({
        status: 200,
        body: JSON.stringify({ validationMessages: [] }),
      }));
      const { fireGa4Event } = await load();
      const result = await fireGa4Event('call_received', { location: 'brickell' });
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('GA4 integration with VC-3 dispatcher', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token-xyz',
      MISSED_CALL_AUTOTEXT_ENABLED: 'false',
      GA4_MEASUREMENT_ID: 'G-TESTID',
      GA4_API_SECRET: 'secret',
      GA4_DEBUG_MODE: 'false',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('dispatcher rejection fires auto_text_suppressed with suppression_reason matching the gate', async () => {
    // Mock Upstash so Gate 0 passes.
    const fakeStore = new Map();
    vi.doMock('@upstash/redis', () => ({
      Redis: class FakeRedis {
        async set(k, v, opts) {
          if (opts?.nx && fakeStore.has(k)) return null;
          fakeStore.set(k, v);
          return 'OK';
        }
        async get(k) { return fakeStore.get(k) ?? null; }
      },
    }));

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 204,
      text: async () => '', json: async () => ({}), clone() { return this; },
    });
    vi.stubGlobal('fetch', fetchSpy);

    vi.resetModules();
    const { dispatchMissedCallAutotext } = await import('../src/lib/missed-call-dispatcher.js');

    await dispatchMissedCallAutotext({
      callSid: 'CA_ga4_integration',
      callerPhone: '+19175551234',
      locationCalled: 'brickell',
      timestamp: new Date().toISOString(),
    });

    // Kill switch is off → suppression_reason = kill_switch
    const suppressedCall = fetchSpy.mock.calls.find(c => {
      const body = JSON.parse(c[1].body);
      return body.events[0].name === 'auto_text_suppressed';
    });
    expect(suppressedCall).toBeDefined();
    const suppressedBody = JSON.parse(suppressedCall[1].body);
    expect(suppressedBody.events[0].params.suppression_reason).toBe('kill_switch');
    expect(suppressedBody.events[0].params.location_name).toBe('brickell');
    expect(suppressedBody.events[0].params.caller_phone_hash).toMatch(/^[a-f0-9]{64}$/);

    vi.doUnmock('@upstash/redis');
    vi.unstubAllGlobals();
  });
});
