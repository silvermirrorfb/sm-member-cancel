import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-3 (hardening 2026-06-19): /api/health?deep=1 must live-probe Boulevard,
// Twilio, Klaviyo, and Sheets with a cheap authenticated read, not just confirm
// the env vars are present (env-presence is how the dead Anthropic model hid).
// Any provider whose credential does not actually work degrades to 503.

const mockGetAnthropicModel = vi.fn();
const mockVerifyAnthropicModel = vi.fn();
vi.mock('../src/lib/claude.js', () => ({
  getAnthropicModel: (...a) => mockGetAnthropicModel(...a),
  verifyAnthropicModel: (...a) => mockVerifyAnthropicModel(...a),
}));

const mockProbeRedis = vi.fn();
const mockProbeBoulevard = vi.fn();
const mockProbeTwilio = vi.fn();
const mockProbeKlaviyo = vi.fn();
const mockProbeSheets = vi.fn();
vi.mock('../src/lib/health-probes.js', () => ({
  probeRedis: (...a) => mockProbeRedis(...a),
  probeBoulevard: (...a) => mockProbeBoulevard(...a),
  probeTwilio: (...a) => mockProbeTwilio(...a),
  probeKlaviyo: (...a) => mockProbeKlaviyo(...a),
  probeSheets: (...a) => mockProbeSheets(...a),
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

describe('health route provider deep probes', () => {
  beforeEach(() => {
    process.env = allEnv();
    vi.clearAllMocks();
    mockGetAnthropicModel.mockReturnValue('claude-sonnet-4-6');
    mockVerifyAnthropicModel.mockResolvedValue({ ok: true, model: 'claude-sonnet-4-6' });
    const ok = { ok: true, configured: true };
    mockProbeRedis.mockResolvedValue(ok);
    mockProbeBoulevard.mockResolvedValue(ok);
    mockProbeTwilio.mockResolvedValue(ok);
    mockProbeKlaviyo.mockResolvedValue(ok);
    mockProbeSheets.mockResolvedValue(ok);
  });
  afterEach(() => { process.env = originalEnv; });

  it('does not run any provider probe on the default (non-deep) path', async () => {
    const res = await GET(new Request('https://x/api/health'));
    expect(res.status).toBe(200);
    expect(mockProbeBoulevard).not.toHaveBeenCalled();
    expect(mockProbeTwilio).not.toHaveBeenCalled();
    expect(mockProbeKlaviyo).not.toHaveBeenCalled();
    expect(mockProbeSheets).not.toHaveBeenCalled();
  });

  it('?deep=1 runs all four provider probes and stays healthy when they pass', async () => {
    const res = await GET(new Request('https://x/api/health?deep=1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockProbeBoulevard).toHaveBeenCalledTimes(1);
    expect(mockProbeTwilio).toHaveBeenCalledTimes(1);
    expect(mockProbeKlaviyo).toHaveBeenCalledTimes(1);
    expect(mockProbeSheets).toHaveBeenCalledTimes(1);
    expect(body.probes.boulevard.ok).toBe(true);
    expect(body.probes.twilio.ok).toBe(true);
    expect(body.probes.klaviyo.ok).toBe(true);
    expect(body.probes.sheets.ok).toBe(true);
  });

  const providers = [
    ['boulevard', () => mockProbeBoulevard],
    ['twilio', () => mockProbeTwilio],
    ['klaviyo', () => mockProbeKlaviyo],
    ['sheets', () => mockProbeSheets],
  ];

  for (const [name, getMock] of providers) {
    it(`?deep=1 returns 503 + ok:false for ${name} when its credential fails`, async () => {
      getMock().mockResolvedValue({ ok: false, configured: true, error: 'HTTP 401' });
      const res = await GET(new Request('https://x/api/health?deep=1'));
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.status).toBe('degraded');
      expect(body.probes[name].ok).toBe(false);
      expect(body.probes[name].error).toBe('HTTP 401');
    });
  }
});
