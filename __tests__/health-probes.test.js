import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for the Redis health probe itself (the route tests mock it).
// Asserts the round-trip semantics and, per the codex review, that a SET that
// succeeds is always cleaned up even when the GET rejects mid-probe.

const h = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), del: vi.fn(), ctor: vi.fn() }));
const set = h.set;
const get = h.get;
const del = h.del;
const RedisCtor = h.ctor;
// Redis is used with `new`, so the mock must be a real (newable) function that
// returns the stub client.
vi.mock('@upstash/redis', () => ({
  Redis: function (...args) { h.ctor(...args); return { set: h.set, get: h.get, del: h.del }; },
}));

const originalEnv = process.env;

async function freshProbe() {
  vi.resetModules();
  const mod = await import('../src/lib/health-probes.js');
  return mod.probeRedis;
}

describe('probeRedis', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: 'https://redis.example',
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    };
    vi.clearAllMocks();
    set.mockResolvedValue('OK');
    del.mockResolvedValue(1);
  });
  afterEach(() => { process.env = originalEnv; });

  it('returns not-configured (no Redis client built) when env is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const probeRedis = await freshProbe();
    const r = await probeRedis();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(false);
    expect(RedisCtor).not.toHaveBeenCalled();
  });

  it('does a set/get/del round-trip and returns ok when the read-back matches', async () => {
    get.mockImplementation(async (key) => {
      // echo back the value that was set under this key
      return set.mock.calls.find(c => c[0] === key)?.[1] ?? null;
    });
    const probeRedis = await freshProbe();
    const r = await probeRedis();
    expect(r.ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    // set used a TTL so a missed del cannot leak the key forever
    expect(set.mock.calls[0][2]).toMatchObject({ ex: expect.any(Number) });
  });

  it('returns ok:false on a read-back mismatch and still cleans up', async () => {
    get.mockResolvedValue('not-the-nonce');
    const probeRedis = await freshProbe();
    const r = await probeRedis();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mismatch/);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('still attempts cleanup (del) when GET rejects after a successful SET', async () => {
    get.mockRejectedValue(new Error('ECONNRESET'));
    const probeRedis = await freshProbe();
    const r = await probeRedis();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
    expect(del).toHaveBeenCalledTimes(1); // cleanup ran despite the GET failure
  });

  it('does not attempt del when the SET itself fails (nothing was written)', async () => {
    set.mockRejectedValue(new Error('ECONNREFUSED'));
    const probeRedis = await freshProbe();
    const r = await probeRedis();
    expect(r.ok).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });
});
