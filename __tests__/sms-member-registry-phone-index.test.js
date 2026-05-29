import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRedis = {
  hset: vi.fn(),
  hget: vi.fn(),
  hdel: vi.fn(),
  hgetall: vi.fn(),
  scan: vi.fn(),
};

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function MockRedis() {
    return mockRedis;
  }),
}));

const ORIGINAL_ENV = process.env;

describe('sms-member-registry phone index', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };
    vi.resetModules();
    Object.values(mockRedis).forEach(fn => fn.mockReset());
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('setPhoneIndexEntry stores by last-10-digit phone key', async () => {
    mockRedis.hset.mockResolvedValue(1);
    const reg = await import('../src/lib/sms-member-registry.js');
    const ok = await reg.setPhoneIndexEntry('+12025551234', 'urn:blvd:Client:abc', 'loc-1');
    expect(ok).toBe(true);
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'sms-registry:phone-index',
      { '2025551234': expect.stringContaining('"clientId":"urn:blvd:Client:abc"') },
    );
  });

  it('setPhoneIndexEntry normalizes formatted phone to last-10-digit key', async () => {
    mockRedis.hset.mockResolvedValue(1);
    const reg = await import('../src/lib/sms-member-registry.js');
    await reg.setPhoneIndexEntry('(202) 555-1234', 'urn:blvd:Client:abc', null);
    expect(mockRedis.hset.mock.calls[0][1]).toHaveProperty('2025551234');
  });

  it('setPhoneIndexEntry refuses phones shorter than 10 digits', async () => {
    const reg = await import('../src/lib/sms-member-registry.js');
    const ok = await reg.setPhoneIndexEntry('123', 'urn:blvd:Client:abc', null);
    expect(ok).toBe(false);
    expect(mockRedis.hset).not.toHaveBeenCalled();
  });

  it('lookupClientIdByPhoneFromIndex hits when phone is indexed', async () => {
    mockRedis.hget.mockResolvedValue(JSON.stringify({
      clientId: 'urn:blvd:Client:xyz',
      locationId: 'loc-2',
      updatedAt: '2026-05-25T19:00:00Z',
    }));
    const reg = await import('../src/lib/sms-member-registry.js');
    const result = await reg.lookupClientIdByPhoneFromIndex('+12025551234');
    expect(result?.clientId).toBe('urn:blvd:Client:xyz');
    expect(mockRedis.hget).toHaveBeenCalledWith('sms-registry:phone-index', '2025551234');
  });

  it('lookupClientIdByPhoneFromIndex returns null on miss', async () => {
    mockRedis.hget.mockResolvedValue(null);
    const reg = await import('../src/lib/sms-member-registry.js');
    const result = await reg.lookupClientIdByPhoneFromIndex('+12025551234');
    expect(result).toBeNull();
  });

  it('lookupClientIdByPhoneFromIndex fails open on Redis error', async () => {
    mockRedis.hget.mockRejectedValue(new Error('redis down'));
    const reg = await import('../src/lib/sms-member-registry.js');
    const result = await reg.lookupClientIdByPhoneFromIndex('+12025551234');
    expect(result).toBeNull();
  });

  it('deletePhoneIndexEntry removes by last-10-digit key', async () => {
    mockRedis.hdel.mockResolvedValue(1);
    const reg = await import('../src/lib/sms-member-registry.js');
    const ok = await reg.deletePhoneIndexEntry('+12025551234');
    expect(ok).toBe(true);
    expect(mockRedis.hdel).toHaveBeenCalledWith('sms-registry:phone-index', '2025551234');
  });
});
