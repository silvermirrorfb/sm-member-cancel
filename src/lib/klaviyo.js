import { normalizePhone } from './sms-sessions';

const DEFAULT_BASE_URL = 'https://a.klaviyo.com/api';
const DEFAULT_REVISION = process.env.KLAVIYO_REVISION || '2026-01-15';
const LOOKUP_TIMEOUT_MS = Number(process.env.KLAVIYO_LOOKUP_TIMEOUT_MS || 10000);
const MAX_PROFILE_PAGES = 5;
// Total wall-clock budget across ALL pagination pages. Without this, five
// slow-but-successful pages could hold a candidate for 5x the per-page
// timeout and starve the cron run that calls the gate per candidate.
const PROFILE_PAGES_TOTAL_BUDGET_MS = LOOKUP_TIMEOUT_MS * 2;
// Consent allowlist (owner decision, 2026-06-10): only SUBSCRIBED and the
// never-set states (missing or empty consent, NEVER_SUBSCRIBED) do not veto.
// Any other consent value, including states Klaviyo may introduce later,
// vetoes the phone with the same weight as an explicit revocation, so the
// gate fails closed on unknown consent states.
const NON_VETO_CONSENT_VALUES = new Set(['', 'SUBSCRIBED', 'NEVER_SUBSCRIBED']);
// STOP suppression skips ONLY explicit revocation states. Unknown consent
// values are targeted: unknown vetoes the gate and gets revoked on STOP,
// so both directions fail toward suppression (owner decision, 2026-06-10).
const STOP_SKIP_CONSENT_VALUES = new Set(['UNSUBSCRIBED', 'SUPPRESSED', 'REVOKED']);
// Wall-clock cap for the whole revocation loop. The Twilio webhook awaits
// this call inline and Twilio allows roughly 15 seconds end to end.
const STOP_REVOCATION_BUDGET_MS = 10000;
// Circuit breaker: the wall-clock budget alone cannot stop a request storm
// when Klaviyo fails FAST (instant 429/400 responses barely advance the
// clock, and overflow can hold up to 500 targets). After this many
// consecutive failures the remaining targets are marked failed without
// posting, so one STOP cannot amplify a Klaviyo incident.
const STOP_REVOCATION_MAX_CONSECUTIVE_FAILURES = 5;

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
  // Klaviyo's maximum page size. Default is 20, which would force five
  // sequential round trips to see 100 profiles; at 100 every realistic
  // profile set resolves in one page and the overflow cap covers 500.
  url.searchParams.set('page[size]', '100');
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
  // Overflow keeps the accumulated profiles: the consent gate ignores them
  // (it returns early on !ok), but the STOP path revokes what is in hand
  // before failing loud (owner decision, 2026-06-10).
  return { ok: false, status: null, profiles, overflow: true };
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
    revoked: !NON_VETO_CONSENT_VALUES.has(consent),
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

// One revocation job per profile via profile-subscription-bulk-delete-jobs,
// Klaviyo's canonical endpoint for honoring an opt-out. Per-profile posts
// (rather than one bulk job) make per-profile retry and partial-failure
// reporting possible; profile counts per phone are tiny in practice.
async function postRevocationJob(config, profileId, selection, timeoutMs = LOOKUP_TIMEOUT_MS) {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/profile-subscription-bulk-delete-jobs/`, {
      method: 'POST',
      headers: {
        ...createHeaders(config),
        'content-type': 'application/json',
      },
      body: JSON.stringify(unsubPayload),
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => '');
      // Scrub digit runs at the source: Klaviyo validation errors echo the
      // posted phone_number, and these details sit in failure records that
      // future code might log. Empty bodies fall back to the status code so
      // a genuine HTTP failure is never mislabeled downstream.
      const detail = text.replace(/\d{7,}/g, '<redacted>').slice(0, 160) || `http_${response.status}`;
      return { ok: false, status: response.status, detail };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    const detail = String(err?.message || err).replace(/\d{7,}/g, '<redacted>').slice(0, 160);
    return { ok: false, status: null, detail };
  } finally {
    clearTimeout(timeout);
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

  // Fetch EVERY profile on the contact through the same paginated,
  // host-pinned, budgeted helper the consent gate uses. Revoking only the
  // first profile leaves duplicate profiles SUBSCRIBED, so other Klaviyo
  // senders could still text a number that texted STOP.
  let fetched;
  try {
    fetched = await fetchAllProfilesByFilter(config, selection.filter);
  } catch (err) {
    const detail = String(err?.message || err).replace(/\d{7,}/g, '<redacted>').slice(0, 160);
    console.error(`[klaviyo-unsub] STOP lookup threw matchedBy=${selection.matchedBy} error=${detail}`);
    return { ok: false, reason: 'lookup_error', error: detail };
  }

  // Overflow still holds every profile fetched before the cap. Revoke what
  // is in hand FIRST, then fail loud: posting nothing on overflow would
  // leave the number maximally exposed at the exact moment we hold hundreds
  // of revocable profiles (owner decision, 2026-06-10).
  const overflowed = fetched.overflow === true;
  if (!fetched.ok && !overflowed) {
    console.error(
      `[klaviyo-unsub] STOP lookup failed matchedBy=${selection.matchedBy} reason=lookup_failed` +
      `${fetched.status ? ` status=${fetched.status}` : ''}`,
    );
    return { ok: false, reason: 'lookup_failed', ...(fetched.status ? { status: fetched.status } : {}) };
  }

  // Dedupe by id: pagination can repeat a profile when the dataset shifts
  // between page fetches, and double-posting a revocation wastes budget.
  // Profiles without an id cannot be posted and are dropped.
  const seenIds = new Set();
  const uniqueProfiles = [];
  for (const profile of fetched.profiles || []) {
    const id = String(profile?.id || '');
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    uniqueProfiles.push(profile);
  }

  const classified = uniqueProfiles.map(classifyProfile);
  if (classified.length === 0) {
    if (overflowed) {
      console.error(`[klaviyo-unsub] STOP overflow with no usable profiles matchedBy=${selection.matchedBy}`);
      return { ok: false, reason: 'klaviyo_profile_overflow', overflowed: true, matchedBy: selection.matchedBy };
    }
    // No profile exists in Klaviyo for this contact, nothing to unsubscribe.
    // This is fine; treat as success so the STOP flow continues.
    return { ok: true, reason: 'no_profile_found', matchedBy: selection.matchedBy };
  }

  // Skip ONLY explicit revocation states; unknown consent values are
  // targeted so both the gate (veto) and STOP (revoke) fail toward
  // suppression. Phone matches only: the sms consent signal means nothing
  // for an email match.
  const targets = selection.matchedBy === 'phone'
    ? classified.filter(c => !STOP_SKIP_CONSENT_VALUES.has(c.consent))
    : classified;
  const targetIds = new Set(targets.map(c => c.profile.id));
  const alreadyRevokedProfileIds = classified
    .filter(c => !targetIds.has(c.profile.id))
    .map(c => c.profile.id);

  const deadlineMs = Date.now() + STOP_REVOCATION_BUDGET_MS;
  const revokedProfileIds = [];
  const failed = [];
  let consecutiveFailures = 0;
  for (const target of targets) {
    const id = target.profile.id;
    if (consecutiveFailures >= STOP_REVOCATION_MAX_CONSECUTIVE_FAILURES) {
      failed.push({ id, status: null, detail: 'revocation_aborted_consecutive_failures' });
      continue;
    }
    let remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      failed.push({ id, status: null, detail: 'revocation_budget_exhausted' });
      continue;
    }
    let attempt = await postRevocationJob(config, id, selection, Math.min(LOOKUP_TIMEOUT_MS, remainingMs));
    // Retry only network errors and 5xx. A 4xx is deterministic (a 400
    // will 400 again) and an immediate retry on 429 makes a rate-limit
    // storm worse, exactly when the breaker is trying to calm it.
    if (!attempt.ok && (attempt.status === null || attempt.status >= 500)) {
      remainingMs = deadlineMs - Date.now();
      if (remainingMs > 0) {
        attempt = await postRevocationJob(config, id, selection, Math.min(LOOKUP_TIMEOUT_MS, remainingMs));
      }
    }
    if (attempt.ok) {
      revokedProfileIds.push(id);
      consecutiveFailures = 0;
    } else {
      failed.push({ id, status: attempt.status ?? null, detail: attempt.detail });
      consecutiveFailures += 1;
    }
  }

  const profileId = targets[0]?.profile?.id || classified[0]?.profile?.id || null;
  const failedProfileIds = failed.map(f => f.id);
  const lastStatus = failed.length > 0 ? failed[failed.length - 1].status : null;

  if (overflowed || failed.length > 0) {
    console.error(
      `[klaviyo-unsub] STOP ${overflowed ? 'OVERFLOW' : 'revocation FAILED'} matchedBy=${selection.matchedBy} ` +
      `revokedProfiles=${revokedProfileIds.join(',') || 'none'} ` +
      `failedProfiles=${failedProfileIds.join(',') || 'none'} ` +
      `alreadyRevoked=${alreadyRevokedProfileIds.length} ` +
      `profilesEvaluated=${classified.length}` +
      `${lastStatus ? ` lastStatus=${lastStatus}` : ''}`,
    );
  }

  if (overflowed) {
    // Overflow wins over partial_unsubscribe as the reason when both apply.
    return {
      ok: false,
      reason: 'klaviyo_profile_overflow',
      overflowed: true,
      ...(lastStatus ? { status: lastStatus } : {}),
      profileId,
      matchedBy: selection.matchedBy,
      revokedProfileIds,
      failedProfileIds,
      alreadyRevokedProfileIds,
      profilesEvaluated: classified.length,
    };
  }

  if (failed.length > 0) {
    return {
      ok: false,
      reason: revokedProfileIds.length === 0 ? 'unsubscribe_failed' : 'partial_unsubscribe',
      ...(lastStatus ? { status: lastStatus } : {}),
      profileId,
      matchedBy: selection.matchedBy,
      revokedProfileIds,
      failedProfileIds,
      alreadyRevokedProfileIds,
      profilesEvaluated: classified.length,
    };
  }

  console.log(
    `[klaviyo-unsub] STOP honored matchedBy=${selection.matchedBy} profiles=${classified.length} ` +
    `revoked=${revokedProfileIds.length} alreadyRevoked=${alreadyRevokedProfileIds.length}`,
  );
  return {
    ok: true,
    reason: 'unsubscribed',
    profileId,
    matchedBy: selection.matchedBy,
    revokedProfileIds,
    alreadyRevokedProfileIds,
    profilesEvaluated: classified.length,
  };
}

export {
  checkKlaviyoSmsOptIn,
  unsubscribeKlaviyoSms,
};
