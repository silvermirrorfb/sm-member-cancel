import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addToStopSet,
  isOnStopSet,
  removeFromStopSet,
  STOP_SET_KEY,
} from '../src/lib/sms-member-registry.js';

describe('sms stop set', () => {
  const originalEnv = { ...process.env };
  let mockStore;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test_token';
    mockStore = new Set();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function mockRedis() {
    // The registry uses @upstash/redis. We can't easily mock the module,
    // but we can verify via behavior: add then check.
    // These tests exercise the public API.
  }

  it('returns false for both add and check when Redis not configured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const added = await addToStopSet('+19175551234');
    expect(added).toBe(false);
    const onList = await isOnStopSet('+19175551234');
    expect(onList).toBe(false);
  });

  it('rejects malformed phone numbers (short)', async () => {
    const added = await addToStopSet('123');
    expect(added).toBe(false);
  });

  it('rejects null/undefined', async () => {
    expect(await addToStopSet(null)).toBe(false);
    expect(await addToStopSet(undefined)).toBe(false);
    expect(await addToStopSet('')).toBe(false);
    expect(await isOnStopSet(null)).toBe(false);
  });

  it('exports the stop set key for external reference', () => {
    expect(STOP_SET_KEY).toBe('sms-stop-set');
  });

  it('removeFromStopSet returns false without Redis', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const result = await removeFromStopSet('+19175551234');
    expect(result).toBe(false);
  });
});
