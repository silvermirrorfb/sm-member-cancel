import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRateLimitStateForTests,
  buildRateLimitHeaders,
  checkRateLimit,
  getClientIP,
} from '../src/lib/rate-limit.js';

describe('rate-limit helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.RATE_LIMIT_BACKEND;
    delete process.env.RATE_LIMIT_START_MAX;
    __resetRateLimitStateForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    __resetRateLimitStateForTests();
  });

  it('prefers trusted platform IP headers when present', () => {
    const req = new Request('https://example.com', {
      headers: {
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-forwarded-for': '198.51.100.7, 10.0.0.4',
      },
    });

    expect(getClientIP(req)).toBe('203.0.113.9');
  });

  it('falls back to an anonymous fingerprint when IP headers are missing', () => {
    const req = new Request('https://example.com', {
      headers: {
        'x-forwarded-host': 'example.com',
        'user-agent': 'Vitest Agent',
      },
    });

    const clientKey = getClientIP(req);
    expect(clientKey.startsWith('anon:')).toBe(true);
  });

  it('blocks requests once the limit is exceeded in memory mode', async () => {
    const uniqueSuffix = Date.now().toString();
    const ip = `192.0.2.${Number(uniqueSuffix.slice(-2)) || 1}`;
    const route = `message-${uniqueSuffix}`;

    expect((await checkRateLimit(ip, route, 2, 1000)).allowed).toBe(true);
    expect((await checkRateLimit(ip, route, 2, 1000)).allowed).toBe(true);

    const third = await checkRateLimit(ip, route, 2, 1000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.backend).toBe('memory');
  });

  it('honors per-route env overrides', async () => {
    process.env.RATE_LIMIT_START_MAX = '2';

    expect((await checkRateLimit('203.0.113.10', 'start', 10, 1000)).allowed).toBe(true);
    expect((await checkRateLimit('203.0.113.10', 'start', 10, 1000)).allowed).toBe(true);

    const third = await checkRateLimit('203.0.113.10', 'start', 10, 1000);
    expect(third.allowed).toBe(false);
    expect(third.limit).toBe(2);
  });

  it('builds headers for enforcement responses', () => {
    const headers = buildRateLimitHeaders({
      limit: 10,
      remaining: 0,
      resetAt: 123456789,
      backend: 'memory',
      shadowMode: false,
      retryAfterMs: 5000,
    });

    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Remaining']).toBe('0');
    expect(headers['X-RateLimit-Backend']).toBe('memory');
    expect(headers['Retry-After']).toBe('5');
  });
});
