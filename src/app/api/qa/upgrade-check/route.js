import crypto from 'crypto';
import { NextResponse } from 'next/server';
import {
  lookupMember,
  evaluateUpgradeOpportunityForProfile,
  evaluateUpgradeEligibilityFromAppointments,
  resolveNameScanFallbackCandidate,
  buildProfile,
} from '../../../../lib/boulevard';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

const QA_UPGRADE_LIMIT_MAX = Math.max(Number(process.env.QA_UPGRADE_CHECK_RATE_LIMIT_MAX || 40), 1);
const QA_UPGRADE_LIMIT_WINDOW_MS = Math.max(Number(process.env.QA_UPGRADE_CHECK_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000), 1000);
const QA_UPGRADE_IDEMPOTENCY_TTL_MS = Math.max(Number(process.env.QA_UPGRADE_IDEMPOTENCY_TTL_MS || 15 * 60 * 1000), 1000);
const QA_SYNTHETIC_MODE_TOKEN = String(process.env.QA_SYNTHETIC_MODE_TOKEN || '').trim();
const UUID_V4_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyCache = new Map();

function parseBodyValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidTargetDuration(value) {
  return value === 50 || value === 90;
}

function parseNow(value) {
  const raw = parseBodyValue(value);
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildRateLimitHeaders(remaining, retryAfterMs = 0) {
  const headers = {
    'X-RateLimit-Limit': String(QA_UPGRADE_LIMIT_MAX),
    'X-RateLimit-Remaining': String(Math.max(Number(remaining) || 0, 0)),
  };
  if (retryAfterMs > 0) headers['Retry-After'] = String(Math.ceil(retryAfterMs / 1000));
  return headers;
}

function normalizeLocationIdInput(rawLocationId) {
  const value = parseBodyValue(rawLocationId);
  if (!value) return '';
  if (value.startsWith('urn:')) return value;
  if (UUID_V4_LIKE_RE.test(value)) return `urn:blvd:Location:${value}`;
  return value;
}

function parseSyntheticMode(rawValue) {
  const mode = parseBodyValue(rawValue).toLowerCase();
  if (mode === 'eligibility' || mode === 'lookup') return mode;
  return '';
}

function getRequestId(request) {
  const provided = parseBodyValue(request.headers.get('x-request-id') || '');
  return provided || crypto.randomUUID();
}

function getIdempotencyKey(request) {
  return parseBodyValue(request.headers.get('x-idempotency-key') || '');
}

function readIdempotencyEntry(key) {
  if (!key) return null;
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry;
}

function writeIdempotencyEntry(key, fingerprint, status, payload) {
  if (!key) return;
  idempotencyCache.set(key, {
    fingerprint,
    status,
    payload,
    expiresAt: Date.now() + QA_UPGRADE_IDEMPOTENCY_TTL_MS,
  });
}

function buildResponseHeaders({
  requestId,
  remaining,
  retryAfterMs = 0,
  idempotencyKey = '',
  replayed = false,
}) {
  const headers = {
    'X-Request-Id': requestId,
    ...buildRateLimitHeaders(remaining, retryAfterMs),
  };
  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
    headers['X-Idempotency-Replayed'] = replayed ? 'true' : 'false';
  }
  return headers;
}

function isAuthorized(request) {
  const configuredToken = String(process.env.QA_UPGRADE_CHECK_TOKEN || '').trim();
  if (!configuredToken) {
    return process.env.NODE_ENV !== 'production';
  }
  const providedToken = String(request.headers.get('x-qa-token') || '').trim();
  return providedToken === configuredToken;
}

function isSyntheticAuthorized(request) {
  if (!QA_SYNTHETIC_MODE_TOKEN) return process.env.NODE_ENV !== 'production';
  const providedToken = parseBodyValue(request.headers.get('x-qa-synthetic-token') || '');
  return providedToken === QA_SYNTHETIC_MODE_TOKEN;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/qa/upgrade-check',
    method: 'POST',
    notes: 'Read-only Boulevard appointment eligibility check for upgrade QA.',
    required: ['firstName', 'lastName', 'email or phone'],
    optional: ['appointmentId', 'targetDurationMinutes (50|90)', 'locationId', 'now', 'windowHours', 'syntheticMode'],
    syntheticModes: {
      eligibility: ['syntheticProfile', 'syntheticAppointments'],
      lookup: ['firstName', 'lastName', 'email', 'syntheticCandidates'],
    },
  });
}

export async function POST(request) {
  const requestId = getRequestId(request);
  const idempotencyKey = getIdempotencyKey(request);
  const defaultRemaining = QA_UPGRADE_LIMIT_MAX;

  const respond = (payload, status, remaining = defaultRemaining, retryAfterMs = 0, replayed = false) =>
    NextResponse.json(payload, {
      status,
      headers: buildResponseHeaders({
        requestId,
        remaining,
        retryAfterMs,
        idempotencyKey,
        replayed,
      }),
    });

  try {
    if (!isAuthorized(request)) {
      return respond({ error: 'Unauthorized', requestId }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const firstName = parseBodyValue(body.firstName);
    const lastName = parseBodyValue(body.lastName);
    const email = parseBodyValue(body.email).toLowerCase();
    const phone = parseBodyValue(body.phone);
    const appointmentId = parseBodyValue(body.appointmentId);
    const rawLocationId = parseBodyValue(body.locationId);
    const resolvedLocationId = normalizeLocationIdInput(rawLocationId);
    const syntheticMode = parseSyntheticMode(body.syntheticMode);
    const debugMode = body.debug === true || String(body.debug || '').toLowerCase() === 'true';
    const targetDurationMinutes = Number.isFinite(Number(body.targetDurationMinutes))
      ? Number(body.targetDurationMinutes)
      : null;
    const nowIso = parseNow(body.now);
    const windowHours = Number.isFinite(Number(body.windowHours)) ? Number(body.windowHours) : null;
    const fingerprintPayload = {
      firstName,
      lastName,
      email,
      phone,
      appointmentId,
      targetDurationMinutes,
      locationId: resolvedLocationId || null,
      now: nowIso,
      windowHours,
      debugMode,
      syntheticMode,
      syntheticProfile: body.syntheticProfile || null,
      syntheticAppointments: body.syntheticAppointments || null,
      syntheticCandidates: body.syntheticCandidates || null,
    };
    const idempotencyFingerprint = idempotencyKey
      ? crypto.createHash('sha256').update(stableStringify(fingerprintPayload)).digest('hex')
      : '';
    const existingIdempotency = idempotencyKey ? readIdempotencyEntry(idempotencyKey) : null;
    if (existingIdempotency) {
      if (existingIdempotency.fingerprint !== idempotencyFingerprint) {
        return respond({
          error: 'Idempotency key has already been used with a different request payload.',
          requestId,
        }, 409, defaultRemaining, 0, true);
      }
      const replayPayload = {
        ...(existingIdempotency.payload || {}),
        requestId,
      };
      if (replayPayload.qa && typeof replayPayload.qa === 'object') {
        replayPayload.qa = { ...replayPayload.qa, requestId };
      }
      return respond(replayPayload, existingIdempotency.status, defaultRemaining, 0, true);
    }

    const ip = getClientIP(request);
    const { allowed, remaining, retryAfterMs } = checkRateLimit(
      ip,
      'qa-upgrade-check',
      QA_UPGRADE_LIMIT_MAX,
      QA_UPGRADE_LIMIT_WINDOW_MS,
    );
    if (!allowed) {
      return respond(
        { error: 'Too many requests. Please try again shortly.', requestId },
        429,
        remaining,
        retryAfterMs,
      );
    }

    if (syntheticMode && !isSyntheticAuthorized(request)) {
      const payload = { error: 'Unauthorized synthetic mode.', requestId };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 401, payload);
      return respond(payload, 401, remaining);
    }

    if (!firstName || !lastName || (!email && !phone)) {
      if (!syntheticMode || syntheticMode === 'lookup') {
        const payload = {
          error: 'firstName, lastName, and at least one contact (email or phone) are required.',
          requestId,
        };
        if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 400, payload);
        return respond(
          payload,
          400,
          remaining,
        );
      }
    }
    if (syntheticMode === 'lookup' && !email) {
      const payload = {
        error: 'syntheticMode=lookup requires email for mailbox matching.',
        requestId,
      };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 400, payload);
      return respond(
        payload,
        400,
        remaining,
      );
    }
    if (targetDurationMinutes !== null && !isValidTargetDuration(targetDurationMinutes)) {
      const payload = {
        error: 'targetDurationMinutes must be 50 or 90 when provided.',
        requestId,
      };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 400, payload);
      return respond(
        payload,
        400,
        remaining,
      );
    }
    if (body.now && !nowIso) {
      const payload = {
        error: 'now must be a valid date/time string when provided.',
        requestId,
      };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 400, payload);
      return respond(
        payload,
        400,
        remaining,
      );
    }

    if (syntheticMode === 'eligibility') {
      if (!body.syntheticProfile || typeof body.syntheticProfile !== 'object' || !Array.isArray(body.syntheticAppointments)) {
        const payload = {
          error: 'syntheticMode=eligibility requires syntheticProfile (object) and syntheticAppointments (array).',
          requestId,
        };
        if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 400, payload);
        return respond(payload, 400, remaining);
      }

      const profile = buildProfile(body.syntheticProfile || {});
      const opportunity = evaluateUpgradeEligibilityFromAppointments(
        body.syntheticAppointments,
        profile,
        {
          appointmentId: appointmentId || undefined,
          targetDurationMinutes: targetDurationMinutes || undefined,
          now: nowIso || undefined,
          windowHours: windowHours || undefined,
        },
      );
      const payload = {
        ok: true,
        requestId,
        member: {
          name: profile.name,
          firstName: profile.firstName || null,
          email: profile.email || null,
          phone: profile.phone || null,
          clientId: profile.clientId || null,
          tier: profile.tier || null,
          accountStatus: profile.accountStatus || null,
          location: profile.location || null,
          locationId: profile.locationId || null,
          locationCanonicalId: profile.locationCanonicalId || null,
          lookupStrategy: profile.lookupStrategy || null,
        },
        qa: {
          requestId,
          idempotencyKey: idempotencyKey || null,
          syntheticMode,
          synthetic: true,
          appointmentId: appointmentId || null,
          targetDurationMinutes: targetDurationMinutes || null,
          locationId: rawLocationId || null,
          resolvedLocationId: resolvedLocationId || null,
          now: nowIso || null,
          windowHours: windowHours || null,
          debug: debugMode,
          readOnly: true,
        },
        opportunity,
      };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 200, payload);
      return respond(payload, 200, remaining);
    }

    if (syntheticMode === 'lookup') {
      if (!Array.isArray(body.syntheticCandidates)) {
        const payload = {
          error: 'syntheticMode=lookup requires syntheticCandidates (array).',
          requestId,
        };
        if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 400, payload);
        return respond(payload, 400, remaining);
      }

      const fullName = `${firstName} ${lastName}`.trim();
      const fallback = resolveNameScanFallbackCandidate(fullName, email, body.syntheticCandidates);
      const resolvedCandidate = fallback?.candidate?.node || fallback?.candidate || null;
      const payload = {
        ok: true,
        requestId,
        qa: {
          requestId,
          idempotencyKey: idempotencyKey || null,
          syntheticMode,
          synthetic: true,
          debug: debugMode,
          readOnly: true,
        },
        syntheticLookup: {
          matched: Boolean(resolvedCandidate),
          strategy: fallback?.strategy || null,
          reason: fallback?.reason || null,
          candidate: resolvedCandidate
            ? {
                id: resolvedCandidate.id || null,
                firstName: resolvedCandidate.firstName || null,
                lastName: resolvedCandidate.lastName || null,
                email: resolvedCandidate.email || null,
                phone: resolvedCandidate.mobilePhone || null,
                locationId: resolvedCandidate?.primaryLocation?.id || resolvedCandidate.locationId || null,
              }
            : null,
        },
      };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 200, payload);
      return respond(payload, 200, remaining);
    }

    const fullName = `${firstName} ${lastName}`.trim();
    const contacts = [];
    if (email) contacts.push(email);
    if (phone) contacts.push(phone);

    let profile = null;
    let matchedContact = null;
    for (const contact of contacts) {
      profile = await lookupMember(fullName, contact);
      if (profile) {
        matchedContact = contact;
        break;
      }
    }

    if (!profile) {
      const payload = { ok: false, reason: 'member_not_found', requestId };
      if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 404, payload);
      return respond(payload, 404, remaining);
    }

    const opportunity = await evaluateUpgradeOpportunityForProfile(profile, {
      appointmentId: appointmentId || undefined,
      targetDurationMinutes: targetDurationMinutes || undefined,
      locationId: resolvedLocationId || undefined,
      now: nowIso || undefined,
      windowHours: windowHours || undefined,
    });
    const responseOpportunity = debugMode
      ? opportunity
      : opportunity && typeof opportunity === 'object'
      ? (() => {
          const { diagnostics, ...rest } = opportunity;
          return rest;
        })()
      : opportunity;

    const payload = {
      ok: true,
      requestId,
      member: {
        name: profile.name,
        firstName: profile.firstName || null,
        email: profile.email || null,
        phone: profile.phone || null,
        clientId: profile.clientId || null,
        tier: profile.tier || null,
        accountStatus: profile.accountStatus || null,
        location: profile.location || null,
        locationId: profile.locationId || null,
      },
      qa: {
        requestId,
        idempotencyKey: idempotencyKey || null,
        matchedContact,
        appointmentId: appointmentId || null,
        targetDurationMinutes: targetDurationMinutes || null,
        locationId: rawLocationId || null,
        resolvedLocationId: resolvedLocationId || null,
        now: nowIso || null,
        windowHours: windowHours || null,
        debug: debugMode,
        readOnly: true,
      },
      opportunity: responseOpportunity,
    };
    if (idempotencyKey) writeIdempotencyEntry(idempotencyKey, idempotencyFingerprint, 200, payload);
    return respond(payload, 200, remaining);
  } catch (err) {
    console.error('QA upgrade check error:', err);
    return NextResponse.json(
      { error: 'Internal error while running upgrade check.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    );
  }
}
