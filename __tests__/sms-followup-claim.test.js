import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The claim must be DURABLE (Redis SET NX), not in-memory: a double YES or a
// Twilio webhook redelivery can land on a different serverless instance where
// process state is empty. These tests mock the Upstash client at the module
// boundary and drive real NX semantics through a stateful store.
const mockSet = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor() {
      this.set = (...args) => mockSet(...args);
    }
  },
}));

import { claimAppliedFollowupSend } from '../src/lib/sms-member-registry.js';

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

  it('fails closed (false) on an empty or missing key', async () => {
    expect(await claimAppliedFollowupSend('')).toBe(false);
    expect(await claimAppliedFollowupSend(null)).toBe(false);
    expect(await claimAppliedFollowupSend(undefined)).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
