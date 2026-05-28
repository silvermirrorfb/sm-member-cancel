import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = process.env;
const ORIGINAL_FETCH = global.fetch;

describe('sms-registry-seed gate', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      CRON_SECRET: 'test-secret',
      SMS_CRON_LOCATIONS: 'urn:blvd:Location:00000000-0000-0000-0000-000000000001',
      BOULEVARD_API_URL: 'https://test.boulevard',
      BOULEVARD_API_KEY: 'k',
      BOULEVARD_API_SECRET: Buffer.from('s').toString('base64'),
      BOULEVARD_BUSINESS_ID: 'b',
      UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 't',
    };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  function authedRequest() {
    return new Request('http://localhost/api/cron/sms-registry-seed', {
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
  }

  it('runs when SMS_REGISTRY_SEED_ENABLED is unset (defaults true)', async () => {
    delete process.env.SMS_REGISTRY_SEED_ENABLED;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { clients: { edges: [], pageInfo: { hasNextPage: false } } } }),
    }));
    const { GET } = await import('../src/app/api/cron/sms-registry-seed/route.js');
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.skipped).toBeUndefined();
    expect(body.ok).toBe(true);
  });

  it('runs when SMS_CRON_ENABLED is empty (seed independent of master gate)', async () => {
    process.env.SMS_CRON_ENABLED = '';
    delete process.env.SMS_REGISTRY_SEED_ENABLED;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { clients: { edges: [], pageInfo: { hasNextPage: false } } } }),
    }));
    const { GET } = await import('../src/app/api/cron/sms-registry-seed/route.js');
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.skipped).toBeUndefined();
    expect(body.ok).toBe(true);
  });

  it('skips when SMS_REGISTRY_SEED_ENABLED is explicitly false', async () => {
    process.env.SMS_REGISTRY_SEED_ENABLED = 'false';
    const { GET } = await import('../src/app/api/cron/sms-registry-seed/route.js');
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.skipped).toBe('SMS_REGISTRY_SEED_ENABLED is false');
  });
});
