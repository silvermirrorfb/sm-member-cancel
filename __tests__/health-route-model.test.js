import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAnthropicModel = vi.fn();
const mockVerifyAnthropicModel = vi.fn();
vi.mock('../src/lib/claude.js', () => ({
  getAnthropicModel: (...a) => mockGetAnthropicModel(...a),
  verifyAnthropicModel: (...a) => mockVerifyAnthropicModel(...a),
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
  };
}

describe('health route anthropic model check', () => {
  beforeEach(() => {
    process.env = allEnv();
    vi.clearAllMocks();
    mockGetAnthropicModel.mockReturnValue('claude-sonnet-4-6');
  });
  afterEach(() => { process.env = originalEnv; });

  it('does not live-check the model by default (fast path)', async () => {
    const res = await GET(new Request('https://x/api/health'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.anthropicModel).toBe('claude-sonnet-4-6');
    expect(body.anthropicModelCheck).toBeUndefined();
    expect(mockVerifyAnthropicModel).not.toHaveBeenCalled();
  });

  it('?deep=1 surfaces a bad model as a 503 degraded status', async () => {
    mockVerifyAnthropicModel.mockResolvedValue({ ok: false, model: 'claude-sonnet-4-20250514', error: '404 not found' });
    const res = await GET(new Request('https://x/api/health?deep=1'));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.anthropicModelCheck.ok).toBe(false);
    expect(mockVerifyAnthropicModel).toHaveBeenCalledTimes(1);
  });

  it('?deep=1 with a good model stays healthy', async () => {
    mockVerifyAnthropicModel.mockResolvedValue({ ok: true, model: 'claude-sonnet-4-6' });
    const res = await GET(new Request('https://x/api/health?deep=1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.anthropicModelCheck.ok).toBe(true);
  });
});
