import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-2 (hardening 2026-06-19): /api/health?deep=1 must probe Redis with a real
// set/get/del round-trip. Redis runs the sessions, rate limits, the daily
// registry, and the legal STOP list, but the health endpoint never touched it.
// A Redis outage must surface as 503 + ok:false for redis, not a silent green.

const mockGetAnthropicModel = vi.fn();
const mockVerifyAnthropicModel = vi.fn();
vi.mock('../src/lib/claude.js', () => ({
  getAnthropicModel: (...a) => mockGetAnthropicModel(...a),
  verifyAnthropicModel: (...a) => mockVerifyAnthropicModel(...a),
}));

const mockProbeRedis = vi.fn();
vi.mock('../src/lib/health-probes.js', () => ({
  probeRedis: (...a) => mockProbeRedis(...a),
}));

import { GET } from '../src/app/api/health/route.js';

const originalEnv = process.env;
function allEnv() {
  return {
    ...originalEnv,
    ANTHROPIC_API_KEY: 'k', BOULEVARD_API_KEY: 'k', BOULEVARD_API_SECRET: 'k', BOULEVARD_BUSINESS_ID: 'k',
    BOULEVARD_API_URL: 'u', SMTP_HOST: 'h', SMTP_USER: 'u',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{}', GOOGLE_SHEET_ID: 's', GOOGLE_CHATLOG_SHEET_ID: 'c',
    TWILIO_ACCOUNT_SID: 't', KLAVIYO_PRIVATE_API_KEY: 'k',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'tok',
  };
}

describe('health route redis deep probe', () => {
  beforeEach(() => {
    process.env = allEnv();
    vi.clearAllMocks();
    mockGetAnthropicModel.mockReturnValue('claude-sonnet-4-6');
    mockVerifyAnthropicModel.mockResolvedValue({ ok: true, model: 'claude-sonnet-4-6' });
    mockProbeRedis.mockResolvedValue({ ok: true, configured: true });
  });
  afterEach(() => { process.env = originalEnv; });

  it('does not probe Redis on the default (non-deep) path', async () => {
    const res = await GET(new Request('https://x/api/health'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockProbeRedis).not.toHaveBeenCalled();
    expect(body.probes).toBeUndefined();
  });

  it('?deep=1 runs a Redis round-trip and stays healthy when it passes', async () => {
    const res = await GET(new Request('https://x/api/health?deep=1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockProbeRedis).toHaveBeenCalledTimes(1);
    expect(body.probes.redis.ok).toBe(true);
  });

  it('?deep=1 returns 503 + ok:false for redis when the round-trip fails', async () => {
    mockProbeRedis.mockResolvedValue({ ok: false, configured: true, error: 'ECONNREFUSED' });
    const res = await GET(new Request('https://x/api/health?deep=1'));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('degraded');
    expect(body.probes.redis.ok).toBe(false);
    expect(body.probes.redis.error).toBe('ECONNREFUSED');
  });
});
