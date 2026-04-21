import { normalizePhone } from './sms-sessions';

const DEFAULT_BASE_URL = 'https://a.klaviyo.com/api';
const DEFAULT_REVISION = process.env.KLAVIYO_REVISION || '2026-01-15';
const LOOKUP_TIMEOUT_MS = Number(process.env.KLAVIYO_LOOKUP_TIMEOUT_MS || 10000);

function parseEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') ? email : '';
}

function getConfig() {
  const apiKey = String(process.env.KLAVIYO_PRIVATE_API_KEY || '').trim();
  const baseUrl = String(process.env.KLAVIYO_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const revision = String(process.env.KLAVIYO_REVISION || DEFAULT_REVISION).trim();
  return {
    configured: Boolean(apiKey && baseUrl && revision),
    apiKey,
    baseUrl,
    revision,
  };
}

function buildFilter(phone, email) {
  const safePhone = normalizePhone(phone);
  const safeEmail = parseEmail(email);
  if (safePhone) return { filter: `equals(phone_number,"${safePhone}")`, matchedBy: 'phone', value: safePhone };
  if (safeEmail) return { filter: `equals(email,"${safeEmail}")`, matchedBy: 'email', value: safeEmail };
  return null;
}

function createHeaders(config) {
  return {
    'Authorization': `Klaviyo-API-Key ${config.apiKey}`,
    'revision': config.revision,
    'accept': 'application/json',
  };
}

function readSmsMarketing(attributes) {
  return attributes?.subscriptions?.sms?.marketing || null;
}

function normalizeConsent(value) {
  return String(value || '').trim().toUpperCase();
}

function parseCanReceive(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

async function fetchProfileByFilter(config, filterQuery) {
  const url = new URL(`${config.baseUrl}/profiles/`);
  url.searchParams.set('filter', filterQuery);
  url.searchParams.set('additional-fields[profile]', 'subscriptions');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: createHeaders(config),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkKlaviyoSmsOptIn(input = {}) {
  const config = getConfig();
  if (!config.configured) {
    return {
      allowed: false,
      reason: 'klaviyo_not_configured',
      matchedBy: null,
      profileId: null,
      consent: null,
      canReceiveSmsMarketing: null,
    };
  }

  const selection = buildFilter(input.phone, input.email);
  if (!selection) {
    return {
      allowed: false,
      reason: 'klaviyo_missing_contact',
      matchedBy: null,
      profileId: null,
      consent: null,
      canReceiveSmsMarketing: null,
    };
  }

  try {
    const { response, payload } = await fetchProfileByFilter(config, selection.filter);
    if (!response.ok) {
      return {
        allowed: false,
        reason: 'klaviyo_lookup_error',
        status: response.status,
        matchedBy: selection.matchedBy,
        profileId: null,
        consent: null,
        canReceiveSmsMarketing: null,
      };
    }

    const profile = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!profile) {
      return {
        allowed: false,
        reason: 'klaviyo_profile_not_found',
        matchedBy: selection.matchedBy,
        profileId: null,
        consent: null,
        canReceiveSmsMarketing: null,
      };
    }

    const smsMarketing = readSmsMarketing(profile.attributes || {});
    const consent = normalizeConsent(smsMarketing?.consent);
    const canReceive = parseCanReceive(smsMarketing?.can_receive_sms_marketing);
    const allowedByConsent = consent === 'SUBSCRIBED';
    const allowedByReceiveFlag = canReceive !== false;
    const allowed = allowedByConsent && allowedByReceiveFlag;

    return {
      allowed,
      reason: allowed ? null : allowedByConsent ? 'klaviyo_sms_blocked' : 'klaviyo_sms_not_subscribed',
      matchedBy: selection.matchedBy,
      profileId: profile.id || null,
      consent: consent || null,
      canReceiveSmsMarketing: canReceive,
      method: smsMarketing?.method || null,
      consentTimestamp: smsMarketing?.consent_timestamp || null,
      lastUpdated: smsMarketing?.last_updated || null,
    };
  } catch {
    return {
      allowed: false,
      reason: 'klaviyo_lookup_error',
      matchedBy: selection.matchedBy,
      profileId: null,
      consent: null,
      canReceiveSmsMarketing: null,
    };
  }
}

async function unsubscribeKlaviyoSms(input = {}) {
  const config = getConfig();
  if (!config.configured) {
    return { ok: false, reason: 'klaviyo_not_configured' };
  }

  const selection = buildFilter(input.phone, input.email);
  if (!selection) {
    return { ok: false, reason: 'no_phone_or_email' };
  }

  // Find the profile first so we get the ID
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  let profileId = null;
  try {
    const { response, payload } = await fetchProfileByFilter(config, selection.filter);
    if (!response.ok) {
      return { ok: false, reason: 'lookup_failed', status: response.status };
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    profileId = first?.id || null;
    if (!profileId) {
      // No profile exists in Klaviyo for this phone, nothing to unsubscribe.
      // This is fine; treat as success so the STOP flow continues.
      return { ok: true, reason: 'no_profile_found', matchedBy: selection.matchedBy };
    }
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, reason: 'lookup_error', error: String(err?.message || err) };
  }
  clearTimeout(timeout);

  // Unsubscribe via profile-subscription-bulk-delete-jobs.
  // This is Klaviyo's canonical endpoint for honoring an opt-out.
  const unsubPayload = {
    data: {
      type: 'profile-subscription-bulk-delete-job',
      attributes: {
        profiles: {
          data: [
            {
              type: 'profile',
              id: profileId,
              attributes: {
                ...(selection.matchedBy === 'phone' ? { phone_number: selection.value } : {}),
                ...(selection.matchedBy === 'email' ? { email: selection.value } : {}),
                subscriptions: {
                  ...(selection.matchedBy === 'phone'
                    ? { sms: { marketing: { consent: 'UNSUBSCRIBED' }, transactional: { consent: 'UNSUBSCRIBED' } } }
                    : {}),
                  ...(selection.matchedBy === 'email'
                    ? { email: { marketing: { consent: 'UNSUBSCRIBED' } } }
                    : {}),
                },
              },
            },
          ],
        },
      },
    },
  };

  const controller2 = new AbortController();
  const timeout2 = setTimeout(() => controller2.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/profile-subscription-bulk-delete-jobs/`, {
      method: 'POST',
      headers: {
        ...createHeaders(config),
        'content-type': 'application/json',
      },
      body: JSON.stringify(unsubPayload),
      signal: controller2.signal,
    });
    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => '');
      console.warn(`[klaviyo-unsub] Unsubscribe failed for profile ${profileId}:`, response.status, text.slice(0, 200));
      return { ok: false, reason: 'unsubscribe_failed', status: response.status, profileId };
    }
    console.log(`[klaviyo-unsub] Unsubscribed profile ${profileId} via ${selection.matchedBy}`);
    return { ok: true, reason: 'unsubscribed', profileId, matchedBy: selection.matchedBy };
  } catch (err) {
    return { ok: false, reason: 'unsubscribe_error', error: String(err?.message || err), profileId };
  } finally {
    clearTimeout(timeout2);
  }
}

export {
  checkKlaviyoSmsOptIn,
  unsubscribeKlaviyoSms,
};
