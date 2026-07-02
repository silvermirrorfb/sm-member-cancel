import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRateLimitStateForTests,
  checkRateLimit,
  getClientIP,
} from '../src/lib/rate-limit.js';

// Security regression suite for the 2026-07-01 white-box pen test, VULN-2
// (rate-limit IP spoofing via client-forgeable headers).
//
// Confirmed prod topology (2026-07-01): clients connect DIRECTLY to Vercel
// (response headers: server: Vercel, x-vercel-id present; no Cloudflare cf-ray).
// Vercel appends the true client IP as the LAST entry of x-forwarded-for, so
// that is the only trustworthy source. Every other candidate the old code
// trusted (x-vercel-forwarded-for, x-real-ip, cf-connecting-ip, and the FIRST
// x-forwarded-for entry) is client-forgeable under this topology and must be
// ignored, otherwise any caller mints a fresh rate-limit bucket per request.

describe('rate-limit IP resolution — VULN-2 spoofing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.RATE_LIMIT_BACKEND;
    __resetRateLimitStateForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    __resetRateLimitStateForTests();
  });

  it('(b) a forged x-vercel-forwarded-for does not mint a fresh rate-limit bucket', async () => {
    const route = `spoof-${Date.now()}`;
    const realTail = '203.0.113.77'; // Vercel-appended real client IP (constant)

    // Attacker forges every client-controllable header; only the Vercel-appended
    // last x-forwarded-for entry is real and constant across both requests.
    const req1 = new Request('https://example.com', {
      headers: {
        'x-vercel-forwarded-for': '1.1.1.1',
        'cf-connecting-ip': '2.2.2.2',
        'x-forwarded-for': `9.9.9.9, ${realTail}`,
      },
    });
    const req2 = new Request('https://example.com', {
      headers: {
        'x-vercel-forwarded-for': '8.8.8.8',
        'cf-connecting-ip': '7.7.7.7',
        'x-forwarded-for': `6.6.6.6, ${realTail}`,
      },
    });

    expect(getClientIP(req1)).toBe(realTail);
    expect(getClientIP(req2)).toBe(realTail);

    // End-to-end: limit is 2. The forged-header rotation must NOT reset the count.
    expect((await checkRateLimit(getClientIP(req1), route, 2, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(getClientIP(req2), route, 2, 60_000)).allowed).toBe(true);
    const third = await checkRateLimit(getClientIP(req1), route, 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('(b) does not trust cf-connecting-ip when Cloudflare is not in front (confirmed prod topology)', () => {
    const req = new Request('https://example.com', {
      headers: {
        'cf-connecting-ip': '4.4.4.4', // forgeable — no Cloudflare to inject/overwrite it
        'x-forwarded-host': 'sm-member-cancel.vercel.app',
        'user-agent': 'attacker-agent',
      },
    });

    const key = getClientIP(req);
    expect(key).not.toBe('4.4.4.4');
    expect(key.startsWith('anon:')).toBe(true);
  });

  it('(b) does not trust x-real-ip (no proxy chain to anchor it)', () => {
    const req = new Request('https://example.com', {
      headers: {
        'x-real-ip': '5.5.5.5',
        'x-forwarded-host': 'sm-member-cancel.vercel.app',
        'user-agent': 'attacker-agent',
      },
    });

    const key = getClientIP(req);
    expect(key).not.toBe('5.5.5.5');
    expect(key.startsWith('anon:')).toBe(true);
  });

  it('(b) ignores the client-controlled FIRST x-forwarded-for entry, using the appended last entry', () => {
    const req = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.42' },
    });
    expect(getClientIP(req)).toBe('203.0.113.42');
  });

  it('(d) genuinely distinct clients still get independent rate-limit buckets', async () => {
    const route = `distinct-${Date.now()}`;
    const reqA = new Request('https://example.com', {
      headers: { 'x-forwarded-for': 'edge-proxy, 198.51.100.10' },
    });
    const reqB = new Request('https://example.com', {
      headers: { 'x-forwarded-for': 'edge-proxy, 198.51.100.20' },
    });

    const ipA = getClientIP(reqA);
    const ipB = getClientIP(reqB);
    expect(ipA).toBe('198.51.100.10');
    expect(ipB).toBe('198.51.100.20');
    expect(ipA).not.toBe(ipB);

    // Client A exhausts a limit of 1; client B is unaffected (separate bucket).
    expect((await checkRateLimit(ipA, route, 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(ipA, route, 1, 60_000)).allowed).toBe(false);
    expect((await checkRateLimit(ipB, route, 1, 60_000)).allowed).toBe(true);
  });
});
