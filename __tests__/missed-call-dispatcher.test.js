import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeRedisStore = new Map();
const fakeRedisSet = new Set();

class FakeRedis {
  // eslint-disable-next-line no-unused-vars
  constructor(_config) {}

  async set(key, value, options) {
    const k = String(key);
    if (options?.nx && fakeRedisStore.has(k)) return null;
    fakeRedisStore.set(k, String(value));
    return 'OK';
  }

  async get(key) {
    const k = String(key);
    return fakeRedisStore.has(k) ? fakeRedisStore.get(k) : null;
  }

  async del(key) {
    return fakeRedisStore.delete(String(key)) ? 1 : 0;
  }

  async sadd(_key, value) {
    fakeRedisSet.add(String(value));
    return 1;
  }

  async sismember(_key, value) {
    return fakeRedisSet.has(String(value)) ? 1 : 0;
  }

  async srem(_key, value) {
    return fakeRedisSet.delete(String(value)) ? 1 : 0;
  }
}

vi.mock('@upstash/redis', () => ({ Redis: FakeRedis }));

// Mock the actual Twilio HTTP send so tests run without TWILIO_* env
// vars and without hitting the network. The dispatcher's contract with
// twilio.js is: returns the parsed JSON from Twilio's Messages API on
// success, throws on failure.
const twilioSendCalls = [];
let twilioSendShouldThrow = null;
vi.mock('../src/lib/twilio', async () => {
  const actual = await vi.importActual('../src/lib/twilio');
  return {
    ...actual,
    sendTwilioSms: vi.fn(async ({ to, body }) => {
      twilioSendCalls.push({ to, body });
      if (twilioSendShouldThrow) {
        const err = twilioSendShouldThrow;
        twilioSendShouldThrow = null;
        throw err;
      }
      return { sid: `SM_test_${twilioSendCalls.length}`, status: 'queued' };
    }),
  };
});

// Mock Google Sheets logging so tests don't try to authenticate with
// Google. The dispatcher's logSmsChatMessages call must not block the
// success path.
vi.mock('../src/lib/notify', async () => ({
  logSmsChatMessages: vi.fn(async () => ({ logged: true })),
  logCallbackQueueEntry: vi.fn(async () => ({ logged: true })),
  logMissedCallEvent: vi.fn(async () => ({ logged: true })),
}));

const DEFAULT_WINDOW = 'Mon-Sat 09:00-20:00 America/New_York,Sun 10:00-19:00 America/New_York';
// 2026-04-24 is a Friday. 15:00 UTC = 11:00 ET (Mon-Sat 09:00-20:00 ET — within).
const IN_WINDOW = new Date('2026-04-24T15:00:00Z');
// 2026-04-24 07:00 UTC = 03:00 ET — outside.
const OUT_WINDOW_EARLY = new Date('2026-04-24T07:00:00Z');
// 2026-04-25 is a Saturday. 03:00 UTC = 23:00 Friday ET (within? no — 23:00 > 20:00 cutoff)
const SATURDAY_LATE_NIGHT = new Date('2026-04-26T02:30:00Z'); // 22:30 Saturday ET — outside
const SUNDAY_NOON = new Date('2026-04-26T16:00:00Z'); // 12:00 Sunday ET — within

function validPayload(overrides = {}) {
  return {
    callSid: `CA_test_${Math.random().toString(36).slice(2, 8)}`,
    callerPhone: '+19175551234',
    locationCalled: 'brickell',
    timestamp: IN_WINDOW.toISOString(),
    ...overrides,
  };
}

describe('missed-call dispatcher gates', () => {
  const originalEnv = process.env;

  async function load() {
    vi.resetModules();
    const sessionsModule = await import('../src/lib/sessions.js');
    sessionsModule.__resetSessionStoreForTests();
    return import('../src/lib/missed-call-dispatcher.js');
  }

  function setPassThroughEnv(overrides = {}) {
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token-abc',
      SESSION_STORE_BACKEND: 'memory',
      MISSED_CALL_AUTOTEXT_ENABLED: 'true',
      MISSED_CALL_PILOT_LOCATIONS: '["brickell"]',
      MISSED_CALL_SEND_WINDOW_BRICKELL: DEFAULT_WINDOW,
      MISSED_CALL_COOLDOWN_MINUTES: '10',
      MISSED_CALL_CALLSID_DEDUPE_TTL_SECONDS: '86400',
      ...overrides,
    };
  }

  beforeEach(() => {
    fakeRedisStore.clear();
    fakeRedisSet.clear();
    twilioSendCalls.length = 0;
    twilioSendShouldThrow = null;
    setPassThroughEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('Gate 0: second dispatch with same CallSid returns dedupe', async () => {
    const dispatcher = await load();
    const payload = validPayload();
    const first = await dispatcher.dispatchMissedCallAutotext(payload, { now: IN_WINDOW });
    expect(first.sent).toBe(true);
    expect(first.messageSid).toMatch(/^SM_test_/);

    const second = await dispatcher.dispatchMissedCallAutotext(payload, { now: IN_WINDOW });
    expect(second).toEqual({ sent: false, reason: 'dedupe' });
  });

  it('Gate 1: MISSED_CALL_AUTOTEXT_ENABLED=false returns kill_switch', async () => {
    setPassThroughEnv({ MISSED_CALL_AUTOTEXT_ENABLED: 'false' });
    const dispatcher = await load();
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: IN_WINDOW });
    expect(result).toEqual({ sent: false, reason: 'kill_switch' });
  });

  it('Gate 2: unknown locationCalled returns not_in_allowlist', async () => {
    const dispatcher = await load();
    const result = await dispatcher.dispatchMissedCallAutotext(
      validPayload({ locationCalled: 'coral-gables' }),
      { now: IN_WINDOW },
    );
    expect(result).toEqual({ sent: false, reason: 'not_in_allowlist' });
  });

  it('Gate 3: phone on sms-stop-set returns on_stop_set', async () => {
    const dispatcher = await load();
    // Pre-populate the stop set via the FakeRedis shared state.
    // sms-member-registry stores entries as the full normalized digits and last-10.
    fakeRedisSet.add('9175551234');
    fakeRedisSet.add('19175551234');
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: IN_WINDOW });
    expect(result).toEqual({ sent: false, reason: 'on_stop_set' });
  });

  it('Gate 4: phone within cooldown window returns cooldown', async () => {
    const dispatcher = await load();
    // Seed cooldown directly so Gate 4 fires.
    fakeRedisStore.set('missed-call-cooldown:+19175551234', '1');
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: IN_WINDOW });
    expect(result).toEqual({ sent: false, reason: 'cooldown' });
  });

  it('Gate 5: 3 AM call (03:00 ET) returns outside_send_window', async () => {
    const dispatcher = await load();
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: OUT_WINDOW_EARLY });
    expect(result).toEqual({ sent: false, reason: 'outside_send_window' });
  });

  it('Gate 5: Sunday at noon ET is within window', async () => {
    const dispatcher = await load();
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: SUNDAY_NOON });
    expect(result.sent).toBe(true);
    expect(result.sessionId).toBeTruthy();
    expect(result.messageSid).toMatch(/^SM_test_/);
  });

  it('Gate 5: Saturday at 22:30 ET is outside window (Mon-Sat ends at 20:00)', async () => {
    const dispatcher = await load();
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: SATURDAY_LATE_NIGHT });
    expect(result).toEqual({ sent: false, reason: 'outside_send_window' });
  });

  it('Gate 5: dispatcher evaluates window in configured timezone regardless of host TZ', async () => {
    const dispatcher = await load();
    // IN_WINDOW = 15:00 UTC Friday = 11:00 ET (within 09-20) = 00:00 local HST-10 etc.
    // Test runs in whatever TZ — helper must use America/New_York per env string.
    const result = await dispatcher.dispatchMissedCallAutotext(validPayload(), { now: IN_WINDOW });
    expect(result.sent).toBe(true);
  });

  it('All gates pass: SMS is sent, cooldown is set, session is created', async () => {
    const dispatcher = await load();
    const payload = validPayload();
    const result = await dispatcher.dispatchMissedCallAutotext(payload, { now: IN_WINDOW });
    expect(result.sent).toBe(true);
    expect(result.messageSid).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    // Twilio was called with the expected body containing the location name
    expect(twilioSendCalls).toHaveLength(1);
    expect(twilioSendCalls[0].to).toBe('+19175551234');
    expect(twilioSendCalls[0].body).toContain('Brickell');
    expect(twilioSendCalls[0].body).toContain('CALLBACK');
    expect(twilioSendCalls[0].body).toContain('STOP');

    // Cooldown key present
    expect(fakeRedisStore.has('missed-call-cooldown:+19175551234')).toBe(true);
    // Dedupe key present
    expect(fakeRedisStore.has(`missed-call-dispatched-callsid:${payload.callSid}`)).toBe(true);
    // Phone->session index written
    expect(fakeRedisStore.get('sms-session-phone:9175551234')).toBe(result.sessionId);
  });

  it('Twilio send failure returns send_failed reason and does not boot a session', async () => {
    const dispatcher = await load();
    twilioSendShouldThrow = new Error('Twilio 21610: unsubscribed');
    const payload = validPayload();
    const result = await dispatcher.dispatchMissedCallAutotext(payload, { now: IN_WINDOW });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('send_failed');
    expect(result.error).toContain('Twilio 21610');

    // Cooldown should still be set (we set it BEFORE the send to avoid
    // rapid retries on a transient failure).
    expect(fakeRedisStore.has('missed-call-cooldown:+19175551234')).toBe(true);
    // No session, no phone index.
    expect(fakeRedisStore.has('sms-session-phone:9175551234')).toBe(false);
  });

  it('invalid payload returns invalid_payload reason', async () => {
    const dispatcher = await load();
    const result = await dispatcher.dispatchMissedCallAutotext({ callSid: 'CA_x' }, { now: IN_WINDOW });
    expect(result).toEqual({ sent: false, reason: 'invalid_payload' });
  });
});

describe('parseSendWindow / isWithinSendWindow', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses multi-segment env string', async () => {
    const { parseSendWindow } = await import('../src/lib/missed-call-dispatcher.js');
    const segments = parseSendWindow(DEFAULT_WINDOW);
    expect(segments).toHaveLength(2);
    expect(segments[0].days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(segments[0].startMinutes).toBe(9 * 60);
    expect(segments[0].endMinutes).toBe(20 * 60);
    expect(segments[0].timezone).toBe('America/New_York');
    expect(segments[1].days).toEqual([0]);
    expect(segments[1].startMinutes).toBe(10 * 60);
    expect(segments[1].endMinutes).toBe(19 * 60);
  });

  it('empty env string returns empty segments and fails the window check', async () => {
    const { parseSendWindow, isWithinSendWindow } = await import('../src/lib/missed-call-dispatcher.js');
    expect(parseSendWindow('')).toEqual([]);
    expect(isWithinSendWindow('', new Date())).toBe(false);
  });

  it('throws on malformed segment', async () => {
    const { parseSendWindow } = await import('../src/lib/missed-call-dispatcher.js');
    expect(() => parseSendWindow('garbage')).toThrow();
  });
});
