import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The claim must be DURABLE (Redis SET NX), not in-memory: a double YES or a
// Twilio webhook redelivery can land on a different serverless instance where
// process state is empty. These tests mock the Upstash client at the module
// boundary and drive real NX semantics through a stateful store.
const mockSet = vi.fn();
const mockSismember = vi.fn();
const mockSadd = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor() {
      this.set = (...args) => mockSet(...args);
      this.sismember = (...args) => mockSismember(...args);
      this.sadd = (...args) => mockSadd(...args);
    }
  },
}));

import { addToStopSet, checkStopSetStrict, claimAppliedFollowupSend } from '../src/lib/sms-member-registry.js';

describe('claimAppliedFollowupSend (durable once-only follow-up send claim)', () => {
  const originalEnv = { ...process.env };
  let store;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test_token';
    store = new Map();
    mockSet.mockReset();
    mockSet.mockImplementation(async (key, value, opts) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('claims a fresh key once and refuses the same key on redelivery', async () => {
    const first = await claimAppliedFollowupSend('appt:appt-1');
    const second = await claimAppliedFollowupSend('appt:appt-1');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('claims with NX semantics and a bounded TTL so stale claims expire', async () => {
    await claimAppliedFollowupSend('appt:appt-1');
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [key, , opts] = mockSet.mock.calls[0];
    expect(String(key)).toContain('appt:appt-1');
    expect(opts?.nx).toBe(true);
    expect(Number(opts?.ex)).toBeGreaterThan(0);
  });

  it('distinct keys claim independently', async () => {
    expect(await claimAppliedFollowupSend('appt:appt-1')).toBe(true);
    expect(await claimAppliedFollowupSend('appt:appt-2')).toBe(true);
  });

  it('fails closed (false) when Redis is not configured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    expect(await claimAppliedFollowupSend('appt:appt-1')).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('fails closed (false) when the Redis write throws', async () => {
    mockSet.mockRejectedValue(new Error('redis down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await claimAppliedFollowupSend('appt:appt-1')).toBe(false);
    warnSpy.mockRestore();
  });

  it('masks phone digits in the claim failure log (no full number reaches error logs)', async () => {
    // Codex P2 (2026-07-22 gauntlet): the phone-fallback claim key embeds the
    // member's last 10 digits, and a Redis client error can echo the key.
    mockSet.mockRejectedValue(new Error('WRONGTYPE operation against key sms-followup-claim:phone:2134401333'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await claimAppliedFollowupSend('phone:2134401333')).toBe(false);
    const logged = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('2134401333');
    expect(logged).toContain('1333');
    warnSpy.mockRestore();
  });

  it('fails closed (false) on an empty or missing key', async () => {
    expect(await claimAppliedFollowupSend('')).toBe(false);
    expect(await claimAppliedFollowupSend(null)).toBe(false);
    expect(await claimAppliedFollowupSend(undefined)).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('stop-set log masking (Redis errors can echo the phone-bearing command)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test_token';
    mockSet.mockReset();
    mockSismember.mockReset();
    mockSadd.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('checkStopSetStrict masks the phone in its failure log and still returns unknown', async () => {
    mockSismember.mockRejectedValue(new Error('SISMEMBER sms-stop-set 2134401333 failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await checkStopSetStrict('+12134401333')).toBe('unknown');
    const logged = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('2134401333');
    expect(logged).toContain('1333');
    warnSpy.mockRestore();
  });

  it('addToStopSet masks the phone in both its failure log and its success log', async () => {
    mockSadd.mockRejectedValue(new Error('SADD sms-stop-set 12134401333 failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await addToStopSet('+12134401333')).toBe(false);
    const warned = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warned).not.toContain('2134401333');
    warnSpy.mockRestore();

    mockSadd.mockReset().mockResolvedValue(1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await addToStopSet('+12134401333')).toBe(true);
    const logged = logSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('2134401333');
    expect(logged).toContain('1333');
    logSpy.mockRestore();
  });
});
