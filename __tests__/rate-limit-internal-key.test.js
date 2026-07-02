import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRateLimitStateForTests,
  buildInternalRateLimitHeaders,
  resolveClientRateLimitKey,
  getClientIP,
  checkRateLimit,
} from '../src/lib/rate-limit.js';

// The SMS webhook invokes the chat/message route in-process and needs to
// rate-limit by the sender's phone, not by IP. It used to smuggle the phone
// through x-forwarded-for, but E.164 phones (`+15551234567`) fail IP parsing,
// so getClientIP fell back to the anonymous fingerprint — and because the
// internal Request has no host/user-agent, EVERY sender collapsed into the same
// `anon:` bucket. One texter (or the missed-call autotext) could then exhaust
// the whole SMS channel's limit and block everyone else's replies.
//
// The fix: carry a trusted internal identifier that is only honored when it
// arrives with a per-process token an external client cannot know (so an
// outside caller cannot pick its own bucket — that would re-open VULN-2).

describe('internal rate-limit identifier (SMS per-phone bucket)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitStateForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    __resetRateLimitStateForTests();
  });

  function reqWith(headers) {
    return new Request('http://internal/api/chat/message', { method: 'POST', headers });
  }

  it('documents the collapse the fix routes around: two distinct E.164 phones via x-forwarded-for hit one bucket', () => {
    const a = getClientIP(reqWith({ 'x-forwarded-for': '+15551110000' }));
    const b = getClientIP(reqWith({ 'x-forwarded-for': '+15552220000' }));
    expect(a).toBe(b); // the bug: identical anonymous bucket for different senders
  });

  it('resolves the trusted internal identifier when the process token is present', () => {
    const headers = { 'content-type': 'application/json', ...buildInternalRateLimitHeaders('sms:+15551234567') };
    expect(resolveClientRateLimitKey(reqWith(headers))).toBe('sms:+15551234567');
  });

  it('gives distinct SMS senders distinct bucket keys (no global collapse)', () => {
    const a = resolveClientRateLimitKey(reqWith(buildInternalRateLimitHeaders('sms:+15551110000')));
    const b = resolveClientRateLimitKey(reqWith(buildInternalRateLimitHeaders('sms:+15552220000')));
    expect(a).toBe('sms:+15551110000');
    expect(b).toBe('sms:+15552220000');
    expect(a).not.toBe(b);
  });

  it('IGNORES a forged internal identifier that arrives WITHOUT the process token', () => {
    const req = reqWith({
      'x-internal-ratelimit-id': 'sms:attacker-chosen',
      'x-forwarded-for': '203.0.113.50',
    });
    const key = resolveClientRateLimitKey(req);
    expect(key).not.toBe('sms:attacker-chosen');
    expect(key).toBe('203.0.113.50'); // falls back to the real client-IP path
  });

  it('IGNORES a forged internal identifier that arrives with a WRONG token', () => {
    const req = reqWith({
      'x-internal-ratelimit-id': 'sms:attacker-chosen',
      'x-internal-ratelimit-token': 'not-the-real-token',
      'x-forwarded-for': '203.0.113.51',
    });
    expect(resolveClientRateLimitKey(req)).not.toBe('sms:attacker-chosen');
  });

  it('per-phone buckets are independent end-to-end (one sender cannot exhaust another)', async () => {
    const route = `sms-${Date.now()}`;
    const A = resolveClientRateLimitKey(reqWith(buildInternalRateLimitHeaders('sms:+15551110001')));
    const B = resolveClientRateLimitKey(reqWith(buildInternalRateLimitHeaders('sms:+15552220002')));

    expect((await checkRateLimit(A, route, 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(A, route, 1, 60_000)).allowed).toBe(false); // A exhausted its 1
    expect((await checkRateLimit(B, route, 1, 60_000)).allowed).toBe(true);  // B unaffected
  });
});
