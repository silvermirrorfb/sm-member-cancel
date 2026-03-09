import { NextResponse } from 'next/server';
import { lookupMember, evaluateUpgradeOpportunityForProfile } from '../../../../lib/boulevard';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

const QA_UPGRADE_LIMIT_MAX = Math.max(Number(process.env.QA_UPGRADE_CHECK_RATE_LIMIT_MAX || 40), 1);
const QA_UPGRADE_LIMIT_WINDOW_MS = Math.max(Number(process.env.QA_UPGRADE_CHECK_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000), 1000);

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

function buildRateLimitHeaders(remaining, retryAfterMs = 0) {
  const headers = {
    'X-RateLimit-Limit': String(QA_UPGRADE_LIMIT_MAX),
    'X-RateLimit-Remaining': String(Math.max(Number(remaining) || 0, 0)),
  };
  if (retryAfterMs > 0) headers['Retry-After'] = String(Math.ceil(retryAfterMs / 1000));
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

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/qa/upgrade-check',
    method: 'POST',
    notes: 'Read-only Boulevard appointment eligibility check for upgrade QA.',
    required: ['firstName', 'lastName', 'email or phone'],
    optional: ['appointmentId', 'targetDurationMinutes (50|90)', 'locationId', 'now', 'windowHours'],
  });
}

export async function POST(request) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = getClientIP(request);
    const { allowed, remaining, retryAfterMs } = checkRateLimit(
      ip,
      'qa-upgrade-check',
      QA_UPGRADE_LIMIT_MAX,
      QA_UPGRADE_LIMIT_WINDOW_MS,
    );
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again shortly.' },
        { status: 429, headers: buildRateLimitHeaders(remaining, retryAfterMs) },
      );
    }

    const body = await request.json().catch(() => ({}));
    const firstName = parseBodyValue(body.firstName);
    const lastName = parseBodyValue(body.lastName);
    const email = parseBodyValue(body.email).toLowerCase();
    const phone = parseBodyValue(body.phone);
    const appointmentId = parseBodyValue(body.appointmentId);
    const locationId = parseBodyValue(body.locationId);
    const debugMode = body.debug === true || String(body.debug || '').toLowerCase() === 'true';
    const targetDurationMinutes = Number.isFinite(Number(body.targetDurationMinutes))
      ? Number(body.targetDurationMinutes)
      : null;
    const nowIso = parseNow(body.now);
    const windowHours = Number.isFinite(Number(body.windowHours)) ? Number(body.windowHours) : null;

    if (!firstName || !lastName || (!email && !phone)) {
      return NextResponse.json(
        { error: 'firstName, lastName, and at least one contact (email or phone) are required.' },
        { status: 400 },
      );
    }
    if (targetDurationMinutes !== null && !isValidTargetDuration(targetDurationMinutes)) {
      return NextResponse.json(
        { error: 'targetDurationMinutes must be 50 or 90 when provided.' },
        { status: 400 },
      );
    }
    if (body.now && !nowIso) {
      return NextResponse.json(
        { error: 'now must be a valid date/time string when provided.' },
        { status: 400 },
      );
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
      return NextResponse.json(
        { ok: false, reason: 'member_not_found' },
        { status: 404 },
      );
    }

    const opportunity = await evaluateUpgradeOpportunityForProfile(profile, {
      appointmentId: appointmentId || undefined,
      targetDurationMinutes: targetDurationMinutes || undefined,
      locationId: locationId || undefined,
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

    return NextResponse.json({
      ok: true,
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
        matchedContact,
        appointmentId: appointmentId || null,
        targetDurationMinutes: targetDurationMinutes || null,
        locationId: locationId || null,
        now: nowIso || null,
        windowHours: windowHours || null,
        debug: debugMode,
        readOnly: true,
      },
      opportunity: responseOpportunity,
    }, { headers: buildRateLimitHeaders(remaining, 0) });
  } catch (err) {
    console.error('QA upgrade check error:', err);
    return NextResponse.json({ error: 'Internal error while running upgrade check.' }, { status: 500 });
  }
}
