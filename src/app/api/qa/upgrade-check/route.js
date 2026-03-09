import { NextResponse } from 'next/server';
import { lookupMember, evaluateUpgradeOpportunityForProfile } from '../../../../lib/boulevard';
import { checkRateLimit, getClientIP } from '../../../../lib/rate-limit';

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
    optional: ['appointmentId', 'targetDurationMinutes (50|90)', 'now', 'windowHours'],
  });
}

export async function POST(request) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = getClientIP(request);
    const { allowed, retryAfterMs } = checkRateLimit(ip, 'qa-upgrade-check', 20, 10 * 60 * 1000);
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    const body = await request.json().catch(() => ({}));
    const firstName = parseBodyValue(body.firstName);
    const lastName = parseBodyValue(body.lastName);
    const email = parseBodyValue(body.email).toLowerCase();
    const phone = parseBodyValue(body.phone);
    const appointmentId = parseBodyValue(body.appointmentId);
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
      now: nowIso || undefined,
      windowHours: windowHours || undefined,
    });

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
      },
      qa: {
        matchedContact,
        appointmentId: appointmentId || null,
        targetDurationMinutes: targetDurationMinutes || null,
        now: nowIso || null,
        windowHours: windowHours || null,
        readOnly: true,
      },
      opportunity,
    });
  } catch (err) {
    console.error('QA upgrade check error:', err);
    return NextResponse.json({ error: 'Internal error while running upgrade check.' }, { status: 500 });
  }
}
