import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkKlaviyoSmsOptIn, unsubscribeKlaviyoSms } from '../src/lib/klaviyo.js';

function profileFixture(id, marketing) {
  return { id, attributes: { subscriptions: { sms: { marketing } } } };
}

function pageResponse(profiles, nextUrl = null) {
  return {
    ok: true,
    json: async () => ({ data: profiles, links: { next: nextUrl } }),
  };
}

const SUBSCRIBED = { consent: 'SUBSCRIBED', can_receive_sms_marketing: true, method: 'WEBFORM' };
const UNSUBSCRIBED_M = { consent: 'UNSUBSCRIBED', can_receive_sms_marketing: false };
const NEVER_SET = {};

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

  it('passes a dual-profile phone when the sibling profile has never-set consent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED), profileFixture('klyv-never', NEVER_SET)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.profileId).toBe('klyv-sub');
    expect(result.profilesEvaluated).toBe(2);
  });

  it('blocks a dual-profile phone when ANY profile is explicitly unsubscribed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED), profileFixture('klyv-revoked', UNSUBSCRIBED_M)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_revoked');
    expect(result.profileId).toBe('klyv-revoked');
    expect(result.profilesEvaluated).toBe(2);

    const gateLines = logSpy.mock.calls.map(args => args.join(' ')).filter(l => l.includes('[klaviyo-gate]'));
    expect(gateLines.length).toBe(1);
    expect(gateLines[0]).toContain('klyv-revoked');
    expect(gateLines[0]).not.toContain('6017578889');
    logSpy.mockRestore();
  });

  it('blocks a dual-profile phone when both profiles have never-set consent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-n1', NEVER_SET), profileFixture('klyv-n2', NEVER_SET)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_not_subscribed');
  });

  it('follows links.next so an unsubscribe on page two blocks the phone', async () => {
    const nextUrl = 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=abc123';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-page1', SUBSCRIBED)], nextUrl))
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-page2', UNSUBSCRIBED_M)]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+1 (601) 757-8889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_revoked');
    expect(result.profileId).toBe('klyv-page2');
    expect(result.profilesEvaluated).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain('equals(phone_number,"+16017578889")');
    const page2Url = decodeURIComponent(String(fetchMock.mock.calls[1][0]));
    expect(page2Url).toContain('page[cursor]=abc123');
    expect(page2Url).toContain('additional-fields[profile]=subscriptions');
    const page2Headers = fetchMock.mock.calls[1][1].headers;
    expect(page2Headers.Authorization).toBe('Klaviyo-API-Key pk_test_123');
    expect(page2Headers.revision).toBe('2026-01-15');
  });

  it('fails closed on a Klaviyo 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ errors: [{ detail: 'upstream' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
    expect(result.status).toBe(503);
  });

  it('keeps the legacy blocked reason for a subscribed profile that cannot receive sms', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-blocked', { consent: 'SUBSCRIBED', can_receive_sms_marketing: false })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_blocked');
    expect(result.profileId).toBe('klyv-blocked');
  });

  it('blocks a dual-profile phone when a sibling profile cannot receive sms marketing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([
        profileFixture('klyv-sub', SUBSCRIBED),
        profileFixture('klyv-suppressed', { consent: 'SUBSCRIBED', can_receive_sms_marketing: false }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_blocked');
    expect(result.profileId).toBe('klyv-suppressed');
    expect(result.profilesEvaluated).toBe(2);
  });

  it('fails closed when pagination never terminates within the page cap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-loop', SUBSCRIBED)], 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=loop'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_profile_overflow');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each(['SUPPRESSED', 'REVOKED'])('blocks when a sibling profile consent is %s', async (consent) => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED), profileFixture('klyv-veto', { consent })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_revoked');
    expect(result.profileId).toBe('klyv-veto');
  });

  it('blocks when a sibling profile carries an unknown consent value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED), profileFixture('klyv-unknown', { consent: 'PAUSED' })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_sms_revoked');
    expect(result.profileId).toBe('klyv-unknown');
  });

  it('keeps the never-set states non-vetoing under the consent allowlist', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([
        profileFixture('klyv-sub', SUBSCRIBED),
        profileFixture('klyv-nsub', { consent: 'NEVER_SUBSCRIBED' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(true);
    expect(result.profileId).toBe('klyv-sub');
  });

  it('requests the maximum page size so realistic profile sets resolve in one page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(true);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain('page[size]=100');
  });

  it('fails closed when Klaviyo returns an unparseable body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json'); },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
  });

  it('blocks when no profile exists for the phone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pageResponse([])));

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_profile_not_found');
  });

  it('fails closed when a follow-up page fetch rejects', async () => {
    const nextUrl = 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=abc';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-page1', SUBSCRIBED)], nextUrl))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
  });

  it('fails closed when a follow-up page returns a 5xx', async () => {
    const nextUrl = 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=abc';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-page1', SUBSCRIBED)], nextUrl))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
    expect(result.status).toBe(500);
  });

  it('allows a profile set that terminates exactly on the final allowed page', async () => {
    const next = i => `https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=p${i}`;
    const fetchMock = vi.fn();
    for (let i = 1; i <= 5; i++) {
      fetchMock.mockResolvedValueOnce(
        pageResponse([profileFixture(`klyv-p${i}`, SUBSCRIBED)], i < 5 ? next(i) : null),
      );
    }
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(true);
    expect(result.profilesEvaluated).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('fails closed on a malformed links.next instead of deciding from page one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED)], { href: 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=abc' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never follows a pagination link off the configured Klaviyo host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED)], 'https://evil.example.com/api/profiles/?page%5Bcursor%5D=abc'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never follows a pagination link that drops https', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse([profileFixture('klyv-sub', SUBSCRIBED)], 'http://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=abc'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('klaviyo_lookup_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the total pagination budget is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const nextUrl = 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=slow';
      const fetchMock = vi.fn().mockImplementationOnce(async () => {
        vi.advanceTimersByTime(21000);
        return pageResponse([profileFixture('klyv-slow', SUBSCRIBED)], nextUrl);
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await checkKlaviyoSmsOptIn({ phone: '+16017578889' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('klaviyo_lookup_error');
      expect(result.status).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it('reports failure when Klaviyo POST fails twice (initial plus retry)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'klyv-4', attributes: {} }] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'internal error' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'internal error' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+19175551234' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsubscribe_failed');
    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });

  it('revokes BOTH profiles when two subscribed profiles share the phone', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-a', SUBSCRIBED), profileFixture('klyv-b', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('unsubscribed');
    expect(result.revokedProfileIds).toEqual(['klyv-a', 'klyv-b']);
    expect(result.profilesEvaluated).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postedIds = [1, 2].map(i => JSON.parse(fetchMock.mock.calls[i][1].body).data.attributes.profiles.data[0].id);
    expect(postedIds).toEqual(['klyv-a', 'klyv-b']);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/profile-subscription-bulk-delete-jobs/');
  });

  it('skips profiles that are already revoked', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-done', UNSUBSCRIBED_M), profileFixture('klyv-live', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(true);
    expect(result.revokedProfileIds).toEqual(['klyv-live']);
    expect(result.alreadyRevokedProfileIds).toEqual(['klyv-done']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes no revocation posts when every profile is already revoked', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      pageResponse([profileFixture('klyv-d1', UNSUBSCRIBED_M), profileFixture('klyv-d2', UNSUBSCRIBED_M)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('unsubscribed');
    expect(result.revokedProfileIds).toEqual([]);
    expect(result.alreadyRevokedProfileIds).toEqual(['klyv-d1', 'klyv-d2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed revocation once and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-retry', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'flaky' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(true);
    expect(result.revokedProfileIds).toEqual(['klyv-retry']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports partial failure without aborting the remaining revocations', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-bad', SUBSCRIBED), profileFixture('klyv-good', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'down' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'down' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('partial_unsubscribe');
    expect(result.failedProfileIds).toEqual(['klyv-bad']);
    expect(result.revokedProfileIds).toEqual(['klyv-good']);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const errorLines = errorSpy.mock.calls.map(args => args.join(' ')).filter(l => l.includes('[klaviyo-unsub]'));
    expect(errorLines.length).toBe(1);
    expect(errorLines[0]).toContain('klyv-bad');
    expect(errorLines[0]).not.toContain('6017578889');
    errorSpy.mockRestore();
  });

  it('revokes a profile that arrives on the second pagination page', async () => {
    const nextUrl = 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=stop2';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-p1', SUBSCRIBED)], nextUrl))
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-p2', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(true);
    expect(result.revokedProfileIds).toEqual(['klyv-p1', 'klyv-p2']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('revokes the profiles in hand on pagination overflow, then fails loud', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('/profile-subscription-bulk-delete-jobs/')) {
        return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
      }
      return pageResponse([profileFixture('klyv-loop', SUBSCRIBED)], 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=loop');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('klaviyo_profile_overflow');
    expect(result.overflowed).toBe(true);
    expect(result.revokedProfileIds).toEqual(['klyv-loop']);
    expect(result.failedProfileIds).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const errorLines = errorSpy.mock.calls.map(args => args.join(' ')).filter(l => l.includes('[klaviyo-unsub]'));
    expect(errorLines.length).toBe(1);
    expect(errorLines[0]).toContain('klyv-loop');
    errorSpy.mockRestore();
  });

  it('targets a profile with an unknown consent value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-paused', { consent: 'PAUSED' })]))
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(true);
    expect(result.revokedProfileIds).toEqual(['klyv-paused']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails loud when the STOP lookup returns a 5xx', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lookup_failed');
    expect(result.status).toBe(503);
    errorSpy.mockRestore();
  });

  it('fails loud and scrubs the phone when the STOP lookup throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect failed for +16017578889')));

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lookup_error');
    expect(result.error).not.toContain('6017578889');
    errorSpy.mockRestore();
  });

  it.each(['SUPPRESSED', 'REVOKED'])('skips a %s profile on STOP without posting', async (consent) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-skip', { consent }), profileFixture('klyv-live', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.revokedProfileIds).toEqual(['klyv-live']);
    expect(result.alreadyRevokedProfileIds).toEqual(['klyv-skip']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resets the breaker on success so interleaved failures never abort', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const profiles = Array.from({ length: 10 }, (_, i) => profileFixture(`klyv-m${i}`, SUBSCRIBED));
    let post = 0;
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('/profile-subscription-bulk-delete-jobs/')) {
        post += 1;
        return post % 5 === 0
          ? { ok: true, status: 202, json: async () => ({}), text: async () => '' }
          : { ok: false, status: 400, text: async () => 'bad' };
      }
      return pageResponse(profiles);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(result.revokedProfileIds).toEqual(['klyv-m4', 'klyv-m9']);
    errorSpy.mockRestore();
  });

  it('keeps klaviyo_profile_overflow as the reason when posts also fail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let page = 0;
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('/profile-subscription-bulk-delete-jobs/')) {
        return { ok: false, status: 400, text: async () => 'bad' };
      }
      page += 1;
      return pageResponse([profileFixture(`klyv-o${page}`, SUBSCRIBED)], 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=loop');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('klaviyo_profile_overflow');
    expect(result.overflowed).toBe(true);
    expect(result.failedProfileIds.length).toBeGreaterThan(0);
    expect(result.status).toBe(400);
    errorSpy.mockRestore();
  });

  it('fails loud when fetched profiles have no usable id', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValueOnce(
      pageResponse([{ attributes: {} }, { id: '', attributes: {} }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unpostable_profiles');
    expect(result.unpostableCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('revokes every profile on an email match regardless of sms consent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-e1', UNSUBSCRIBED_M), profileFixture('klyv-e2', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ email: 'person@example.com' });
    expect(result.matchedBy).toBe('email');
    expect(result.revokedProfileIds).toEqual(['klyv-e1', 'klyv-e2']);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.data.attributes.profiles.data[0].attributes.subscriptions.email.marketing.consent).toBe('UNSUBSCRIBED');
  });

  it('does not retry a 4xx revocation failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pageResponse([profileFixture('klyv-bad400', SUBSCRIBED)]))
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad request' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsubscribe_failed');
    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('trips the circuit breaker after consecutive failures instead of storming Klaviyo', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const profiles = ['klyv-s1', 'klyv-s2', 'klyv-s3', 'klyv-s4', 'klyv-s5', 'klyv-s6', 'klyv-s7']
      .map(id => profileFixture(id, SUBSCRIBED));
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('/profile-subscription-bulk-delete-jobs/')) {
        return { ok: false, status: 429, text: async () => 'rate limited' };
      }
      return pageResponse(profiles);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsubscribe_failed');
    expect(result.failedProfileIds).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    errorSpy.mockRestore();
  });

  it('stops posting at the revocation budget and reports the unattempted profile', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(pageResponse([profileFixture('klyv-a', SUBSCRIBED), profileFixture('klyv-b', SUBSCRIBED)]))
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(11000);
          return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
        });
      vi.stubGlobal('fetch', fetchMock);

      const result = await unsubscribeKlaviyoSms({ phone: '+16017578889' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('partial_unsubscribe');
      expect(result.revokedProfileIds).toEqual(['klyv-a']);
      expect(result.failedProfileIds).toEqual(['klyv-b']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const errorLines = errorSpy.mock.calls.map(args => args.join(' ')).filter(l => l.includes('[klaviyo-unsub]'));
      expect(errorLines.length).toBe(1);
      expect(errorLines[0]).toContain('klyv-b');
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
