import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedisCtor = vi.fn();
const mockIncr = vi.fn();
const mockExpire = vi.fn();
const mockGet = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class FakeRedis {
    constructor(config) {
      mockRedisCtor(config);
    }
    incr(key) { return mockIncr(key); }
    expire(key, seconds) { return mockExpire(key, seconds); }
    get(key) { return mockGet(key); }
  },
}));

async function loadModule() {
  vi.resetModules();
  return import('../src/lib/sms-metrics.js');
}

describe('sms-metrics', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.SMS_OUTBOUND_TIMEZONE = 'America/New_York';
    mockRedisCtor.mockReset();
    mockIncr.mockReset();
    mockExpire.mockReset();
    mockGet.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('localDateStr formats YYYY-MM-DD in the metrics timezone', async () => {
    const { localDateStr } = await loadModule();
    // 2026-05-12T03:30:00Z is still 2026-05-11 (23:30) in America/New_York
    expect(localDateStr(new Date('2026-05-12T03:30:00.000Z'))).toBe('2026-05-11');
    // 2026-05-12T13:00:00Z is 2026-05-12 (09:00) in America/New_York
    expect(localDateStr(new Date('2026-05-12T13:00:00.000Z'))).toBe('2026-05-12');
  });

  it('incrementDailySendCount bumps sms-sent:<today> and sets a TTL on first write', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const { incrementDailySendCount, localDateStr } = await loadModule();
    const when = new Date('2026-05-12T18:00:00.000Z'); // 2026-05-12 ET
    const ok = await incrementDailySendCount(when);
    expect(ok).toBe(true);
    expect(mockIncr).toHaveBeenCalledWith(`sms-sent:${localDateStr(when)}`);
    expect(mockExpire).toHaveBeenCalledWith(`sms-sent:${localDateStr(when)}`, 3 * 24 * 60 * 60);
  });

  it('incrementDailySendCount does NOT re-set the TTL on subsequent writes', async () => {
    mockIncr.mockResolvedValueOnce(2);
    const { incrementDailySendCount } = await loadModule();
    await incrementDailySendCount(new Date('2026-05-12T18:00:00.000Z'));
    expect(mockExpire).not.toHaveBeenCalled();
  });

  it('getDailySendCount reads sms-sent:<date> and returns the number', async () => {
    mockGet.mockResolvedValueOnce('7');
    const { getDailySendCount } = await loadModule();
    const n = await getDailySendCount('2026-05-11');
    expect(mockGet).toHaveBeenCalledWith('sms-sent:2026-05-11');
    expect(n).toBe(7);
  });

  it('getDailySendCount returns 0 when the key is missing or non-numeric', async () => {
    mockGet.mockResolvedValueOnce(null);
    const { getDailySendCount } = await loadModule();
    expect(await getDailySendCount('2026-05-10')).toBe(0);
  });

  it('is a safe no-op when Redis is not configured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { incrementDailySendCount, getDailySendCount } = await loadModule();
    expect(await incrementDailySendCount(new Date())).toBe(false);
    expect(await getDailySendCount('2026-05-11')).toBe(0);
    expect(mockRedisCtor).not.toHaveBeenCalled();
  });

  it('does not throw if Redis errors — returns false / 0', async () => {
    mockIncr.mockRejectedValueOnce(new Error('boom'));
    mockGet.mockRejectedValueOnce(new Error('boom'));
    const { incrementDailySendCount, getDailySendCount } = await loadModule();
    expect(await incrementDailySendCount(new Date('2026-05-12T18:00:00.000Z'))).toBe(false);
    expect(await getDailySendCount('2026-05-11')).toBe(0);
  });
});
