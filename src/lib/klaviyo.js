import { normalizePhone } from './sms-sessions';

const DEFAULT_BASE_URL = 'https://a.klaviyo.com/api';
const DEFAULT_REVISION = process.env.KLAVIYO_REVISION || '2026-01-15';
const LOOKUP_TIMEOUT_MS = Number(process.env.KLAVIYO_LOOKUP_TIMEOUT_MS || 10000);
const MAX_PROFILE_PAGES = 5;
// Total wall-clock budget across ALL pagination pages. Without this, five
// slow-but-successful pages could hold a candidate for 5x the per-page
// timeout and starve the cron run that calls the gate per candidate.
const PROFILE_PAGES_TOTAL_BUDGET_MS = LOOKUP_TIMEOUT_MS * 2;
// Explicit revocation values. NEVER_SUBSCRIBED and missing consent are
// "never set" and intentionally NOT in this set: a never-set sibling profile
// must not veto a SUBSCRIBED profile on the same phone.
const REVOKED_CONSENT_VALUES = new Set(['UNSUBSCRIBED', 'SUPPRESSED', 'REVOKED']);

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

async function fetchProfileByFilter(config, filterQuery, timeoutMs = LOOKUP_TIMEOUT_MS) {
  const url = new URL(`${config.baseUrl}/profiles/`);
  url.searchParams.set('filter', filterQuery);
  url.searchParams.set('additional-fields[profile]', 'subscriptions');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

async function fetchProfilesPageByUrl(config, absoluteUrl, timeoutMs = LOOKUP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(absoluteUrl, {
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

// Collects EVERY profile matching the filter, following links.next. The gate
// must see all profiles on a phone: deciding consent from whichever profile
// the API returns first is the defect this exists to fix. Fail closed on any
// non-OK page, unparseable payload, or a next link that survives the page cap.
async function fetchAllProfilesByFilter(config, filterQuery) {
  const deadlineMs = Date.now() + PROFILE_PAGES_TOTAL_BUDGET_MS;
  const profiles = [];
  let pageResult = await fetchProfileByFilter(
    config,
    filterQuery,
    Math.min(LOOKUP_TIMEOUT_MS, PROFILE_PAGES_TOTAL_BUDGET_MS),
  );
  for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
    const { response, payload } = pageResult;
    if (!response.ok || !payload || !Array.isArray(payload.data)) {
      return { ok: false, status: response.status, profiles: null, overflow: false };
    }
    profiles.push(...payload.data);
    const rawNext = payload?.links?.next ?? null;
    if (rawNext === null || rawNext === '') {
      return { ok: true, status: response.status, profiles, overflow: false };
    }
    if (typeof rawNext !== 'string' || !rawNext.trim()) {
      // Anything truthy that is not a string is a malformed pagination link.
      // Deciding consent from a possibly partial profile set would fail open,
      // so fail closed instead.
      return { ok: false, status: response.status, profiles: null, overflow: false };
    }
    let nextParsed = null;
    try {
      const candidate = new URL(rawNext.trim());
      const baseHost = new URL(config.baseUrl).host;
      if (candidate.protocol === 'https:' && candidate.host === baseHost) {
        nextParsed = candidate;
      }
    } catch {
      nextParsed = null;
    }
    if (!nextParsed) {
      // The API key rides on every page request. Never follow a pagination
      // link that leaves the configured Klaviyo host or drops https.
      return { ok: false, status: response.status, profiles: null, overflow: false };
    }
    // Later pages must keep requesting subscription data. If the next link
    // ever drops the param, every page-2+ profile would lack subscriptions,
    // classify as never-set, and a page-2 revocation would silently fail
    // open behind a page-1 SUBSCRIBED profile.
    const fieldsParam = String(nextParsed.searchParams.get('additional-fields[profile]') || '');
    if (!fieldsParam.includes('subscriptions')) {
      nextParsed.searchParams.set('additional-fields[profile]', 'subscriptions');
    }
    if (page === MAX_PROFILE_PAGES - 1) {
      // A next link survives the page cap: ambiguous profile set, do not
      // fetch a page we will not evaluate; fail closed below.
      break;
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      // Total budget exhausted with pages still unread: partial profile set,
      // fail closed as a lookup error (slowness, not profile volume).
      return { ok: false, status: null, profiles: null, overflow: false };
    }
    pageResult = await fetchProfilesPageByUrl(config, nextParsed.toString(), Math.min(LOOKUP_TIMEOUT_MS, remainingMs));
  }
  return { ok: false, status: null, profiles: null, overflow: true };
}

function classifyProfile(profile) {
  const smsMarketing = readSmsMarketing(profile?.attributes || {});
  const consent = normalizeConsent(smsMarketing?.consent);
  const canReceive = parseCanReceive(smsMarketing?.can_receive_sms_marketing);
  return {
    profile,
    smsMarketing,
    consent,
    canReceive,
    satisfies: consent === 'SUBSCRIBED' && canReceive !== false,
    revoked: REVOKED_CONSENT_VALUES.has(consent),
    // An explicit can_receive_sms_marketing: false is an operational
    // suppression signal and vetoes the phone with the same weight as
    // revocation, even when that profile's consent is never-set; a SUBSCRIBED
    // sibling does not rescue it (owner decision, 2026-06-10). The never-set
    // exemption above applies only to profiles WITHOUT an explicit false flag:
    // parseCanReceive returns null for absent flags, false only for an
    // explicit false.
    receiveBlocked: canReceive === false,
  };
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
    const fetched = await fetchAllProfilesByFilter(config, selection.filter);
    if (!fetched.ok) {
      const failReason = fetched.overflow ? 'klaviyo_profile_overflow' : 'klaviyo_lookup_error';
      console.error(
        `[klaviyo-gate] matchedBy=${selection.matchedBy} profiles=none verdict=blocked ` +
        `reason=${failReason}${fetched.status ? ` status=${fetched.status}` : ''}`,
      );
      return {
        allowed: false,
        reason: failReason,
        ...(fetched.status ? { status: fetched.status } : {}),
        matchedBy: selection.matchedBy,
        profileId: null,
        consent: null,
        canReceiveSmsMarketing: null,
      };
    }

    const classified = fetched.profiles.map(classifyProfile);
    if (classified.length === 0) {
      console.log(
        `[klaviyo-gate] matchedBy=${selection.matchedBy} profiles=0 verdict=blocked ` +
        'reason=klaviyo_profile_not_found decidingProfileId=none',
      );
      return {
        allowed: false,
        reason: 'klaviyo_profile_not_found',
        matchedBy: selection.matchedBy,
        profileId: null,
        consent: null,
        canReceiveSmsMarketing: null,
      };
    }

    const satisfying = classified.filter(c => c.satisfies);
    const revoked = classified.filter(c => c.revoked);
    const receiveBlocked = classified.filter(c => c.receiveBlocked);

    let allowed = false;
    let reason = null;
    let deciding = null;
    if (revoked.length > 0) {
      // Explicit revocation anywhere on the phone wins, even over a
      // SUBSCRIBED sibling profile. klaviyo_sms_revoked marks the new
      // sibling-veto case; a plain unsubscribed phone keeps the legacy reason.
      reason = satisfying.length > 0 ? 'klaviyo_sms_revoked' : 'klaviyo_sms_not_subscribed';
      deciding = revoked[0];
    } else if (receiveBlocked.length > 0) {
      // can_receive_sms_marketing false on any profile vetoes the phone, same
      // weight as revocation; a SUBSCRIBED sibling does not rescue it.
      reason = 'klaviyo_sms_blocked';
      deciding = receiveBlocked[0];
    } else if (satisfying.length > 0) {
      allowed = true;
      deciding = satisfying[0];
    } else {
      reason = 'klaviyo_sms_not_subscribed';
      deciding = classified[0];
    }

    console.log(
      `[klaviyo-gate] matchedBy=${selection.matchedBy} profiles=${classified.length} ` +
      `verdict=${allowed ? 'allowed' : 'blocked'}${allowed ? '' : ` reason=${reason}`} ` +
      `decidingProfileId=${deciding?.profile?.id || 'none'}`,
    );

    return {
      allowed,
      reason: allowed ? null : reason,
      matchedBy: selection.matchedBy,
      profileId: deciding?.profile?.id || null,
      consent: deciding?.consent || null,
      canReceiveSmsMarketing: deciding ? deciding.canReceive : null,
      method: deciding?.smsMarketing?.method || null,
      consentTimestamp: deciding?.smsMarketing?.consent_timestamp || null,
      lastUpdated: deciding?.smsMarketing?.last_updated || null,
      profilesEvaluated: classified.length,
    };
  } catch (err) {
    // Long digit runs are scrubbed BEFORE truncation so a phone number can
    // never reach logs, even partially, via an error message that echoes a
    // request URL.
    const detail = String(err?.message || err).replace(/\d{7,}/g, '<redacted>').slice(0, 160);
    console.error(
      `[klaviyo-gate] matchedBy=${selection.matchedBy} verdict=blocked ` +
      `reason=klaviyo_lookup_error error=${String(err?.name || 'Error')}: ${detail}`,
    );
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
