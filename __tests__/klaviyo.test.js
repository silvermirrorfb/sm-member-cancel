import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkKlaviyoSmsOptIn, unsubscribeKlaviyoSms } from '../src/lib/klaviyo.js';

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

describe('klaviyo sms unsubscribe', () => {
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
    const result = await unsubscribeKlaviyoSms({ phone: '+19175551234' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('klaviyo_not_configured');
  });

  it('returns no_phone_or_email when neither provided', async () => {
    const result = await unsubscribeKlaviyoSms({});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_phone_or_email');
  });

  it('succeeds when no profile exists (nothing to unsubscribe)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await unsubscribeKlaviyoSms({ phone: '+19175551234' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no_profile_found');
  });

  it('unsubscribes an existing profile by phone', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'klyv-3', attributes: {} }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({}),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+19175551234' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('unsubscribed');
    expect(result.profileId).toBe('klyv-3');
    expect(result.matchedBy).toBe('phone');

    // Verify the bulk-delete-jobs endpoint was hit
    const secondCall = fetchMock.mock.calls[1];
    expect(String(secondCall[0])).toContain('/profile-subscription-bulk-delete-jobs/');
    expect(secondCall[1].method).toBe('POST');
    const body = JSON.parse(secondCall[1].body);
    expect(body.data.type).toBe('profile-subscription-bulk-delete-job');
    expect(body.data.attributes.profiles.data[0].id).toBe('klyv-3');
    expect(body.data.attributes.profiles.data[0].attributes.subscriptions.sms.marketing.consent).toBe('UNSUBSCRIBED');
  });

  it('reports failure when Klaviyo POST fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'klyv-4', attributes: {} }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal error',
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+19175551234' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsubscribe_failed');
    expect(result.status).toBe(500);
  });
});
