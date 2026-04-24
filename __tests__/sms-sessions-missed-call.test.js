import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeStore = new Map();
const setCalls = [];

vi.mock('@upstash/redis', () => ({
  Redis: class FakeRedis {
    // eslint-disable-next-line no-unused-vars
    constructor(_config) {}

    async set(key, value, options) {
      setCalls.push({ key, value, options });
      fakeStore.set(String(key), String(value));
      return 'OK';
    }

    async get(key) {
      return fakeStore.has(String(key)) ? fakeStore.get(String(key)) : null;
    }

    async del(key) {
      return fakeStore.delete(String(key)) ? 1 : 0;
    }
  },
}));

describe('sms-sessions missed-call helpers', () => {
  const originalEnv = process.env;

  async function load() {
    vi.resetModules();
    const sessionsModule = await import('../src/lib/sessions.js');
    sessionsModule.__resetSessionStoreForTests();
    const smsSessions = await import('../src/lib/sms-sessions.js');
    return { sessionsModule, smsSessions };
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token-xyz',
      SESSION_STORE_BACKEND: 'memory',
    };
    fakeStore.clear();
    setCalls.length = 0;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('getSessionByPhone returns null for unknown phone', async () => {
    const { smsSessions } = await load();
    const session = await smsSessions.getSessionByPhone('+19175550000');
    expect(session).toBeNull();
  });

  it('setSessionByPhone writes the last-10-digit-indexed key with the provided TTL', async () => {
    const { smsSessions } = await load();
    const ok = await smsSessions.setSessionByPhone('+1 (917) 555-1234', 'sess-42', 3600);
    expect(ok).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].key).toBe('sms-session-phone:9175551234');
    expect(setCalls[0].value).toBe('sess-42');
    expect(setCalls[0].options).toMatchObject({ ex: 3600 });
  });

  it('setSessionByPhone defaults TTL to 48 hours when not provided', async () => {
    const { smsSessions } = await load();
    await smsSessions.setSessionByPhone('+19175551234', 'sess-1');
    expect(setCalls[0].options).toMatchObject({ ex: 48 * 60 * 60 });
  });

  it('getSessionByPhone returns the hydrated session for a known phone', async () => {
    const { sessionsModule, smsSessions } = await load();
    const created = await sessionsModule.createSession(null, null);
    await smsSessions.setSessionByPhone('+19175551234', created.id, 3600);

    const resolved = await smsSessions.getSessionByPhone('+19175551234');
    expect(resolved).toBeTruthy();
    expect(resolved.id).toBe(created.id);
  });

  it('createMissedCallSession populates session_mode, origin, caller_phone, location_called, callSid', async () => {
    const { smsSessions } = await load();
    const sessionId = await smsSessions.createMissedCallSession({
      callSid: 'CA_test_1',
      callerPhone: '+19175551234',
      locationCalled: 'brickell',
      timestamp: '2026-04-24T15:00:00Z',
    });
    expect(sessionId).toBeTruthy();

    const fetched = await smsSessions.getSessionByPhone('+19175551234');
    expect(fetched).toBeTruthy();
    expect(fetched.id).toBe(sessionId);
    expect(fetched.session_mode).toBe('missed_call');
    expect(fetched.origin).toBe('missed_call_trigger');
    expect(fetched.caller_phone).toBe('+19175551234');
    expect(fetched.location_called).toBe('brickell');
    expect(fetched.callSid).toBe('CA_test_1');
    expect(fetched.missed_call_triggered_at).toBe('2026-04-24T15:00:00Z');
  });

  it('createSession without options defaults session_mode=general and origin=widget (regression guard)', async () => {
    const { sessionsModule } = await load();
    const created = await sessionsModule.createSession(null, null);
    expect(created.session_mode).toBe('general');
    expect(created.origin).toBe('widget');
  });

  it('existing in-memory phone->session binding keeps working (regression guard)', async () => {
    const { smsSessions } = await load();
    smsSessions.bindPhoneToSession('+1 (917) 555-9999', 'legacy-sess');
    expect(smsSessions.getSessionIdForPhone('9175559999')).toBe('legacy-sess');
  });

  it('setSessionByPhone returns false when Redis is not configured', async () => {
    process.env = { ...originalEnv, SESSION_STORE_BACKEND: 'memory' };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { smsSessions } = await load();
    const ok = await smsSessions.setSessionByPhone('+19175551234', 'sess-x');
    expect(ok).toBe(false);
  });
});
