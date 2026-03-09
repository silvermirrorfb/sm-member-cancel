import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkKlaviyoSmsOptIn } from '../src/lib/klaviyo.js';

describe('klaviyo sms opt-in check', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.KLAVIYO_PRIVATE_API_KEY = 'pk_test_123';
    process.env.KLAVIYO_API_BASE_URL = 'https://a.klaviyo.com/api';
    process.env.KLAVIYO_REVISION = '2026-01-15';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it('returns not configured when key is missing', async () => {
    delete process.env.KLAVIYO_PRIVATE_API_KEY;
    const result = await checkKlaviyoSmsOptIn({ phone: '+19175551234' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_not_configured');
  });

  it('allows subscribed marketing profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'klyv-1',
            attributes: {
              subscriptions: {
                sms: {
                  marketing: {
                    consent: 'SUBSCRIBED',
                    can_receive_sms_marketing: true,
                    method: 'DOUBLE_OPT_IN',
                  },
                },
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+1 (917) 555-1234' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.profileId).toBe('klyv-1');
    expect(result.consent).toBe('SUBSCRIBED');
  });

  it('blocks unsubscribed profiles', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'klyv-2',
            attributes: {
              subscriptions: {
                sms: {
                  marketing: {
                    consent: 'UNSUBSCRIBED',
                    can_receive_sms_marketing: false,
                  },
                },
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ email: 'person@example.com' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_not_subscribed');
    expect(result.matchedBy).toBe('email');
  });
});
