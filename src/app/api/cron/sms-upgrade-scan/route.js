export const maxDuration = 300;

import { NextResponse } from 'next/server';
import {
  canonicalizeBoulevardLocationId,
  resolveBoulevardLocationInput,
} from '../../../../lib/boulevard';
import { getRegisteredMembers, getRegistryCounts } from '../../../../lib/sms-member-registry';
import { isWithinSendWindow, getNextWindowStartIso } from '../../../../lib/sms-window';

const SEND_TIMEZONE = process.env.SMS_SEND_TIMEZONE || 'America/New_York';
const SEND_START_HOUR = Number(process.env.SMS_CRON_SEND_START_HOUR || 9);
const SEND_END_HOUR = Number(process.env.SMS_CRON_SEND_END_HOUR || 19);

function isCronAuthorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const authHeader = String(request.headers.get('authorization') || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim() === secret;
  }
  const fallbackHeader = String(request.headers.get('x-cron-secret') || '').trim();
  return fallbackHeader === secret;
}

function parseEnabledFlag() {
  const raw = String(process.env.SMS_CRON_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parseTargetLocationIds() {
  const raw = String(process.env.SMS_CRON_LOCATIONS || '').trim();
  if (!raw) return new Map();
  const result = new Map();
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const resolved = resolveBoulevardLocationInput(entry);
    const canonId = resolved.canonicalId || canonicalizeBoulevardLocationId(resolved.locationId || '');
    if (canonId) result.set(canonId, resolved.locationName || entry);
  }
  return result;
}

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized cron request.' }, { status: 401 });
  }

  if (!parseEnabledFlag()) {
    return NextResponse.json({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });
  }

  const window = isWithinSendWindow(new Date().toISOString(), {
    timeZone: SEND_TIMEZONE,
    startHour: SEND_START_HOUR,
    endHour: SEND_END_HOUR,
  });
  if (!window.allowed) {
    return NextResponse.json({
      ok: true,
      skipped: 'Outside configured send window',
      sendWindow: window,
      nextWindowStartIso: getNextWindowStartIso(new Date().toISOString(), {
        timeZone: SEND_TIMEZONE,
        startHour: SEND_START_HOUR,
        endHour: SEND_END_HOUR,
      }),
    });
  }

  const targetLocationMap = parseTargetLocationIds();
  if (targetLocationMap.size === 0) {
    return NextResponse.json({ error: 'SMS_CRON_LOCATIONS is empty or invalid.' }, { status: 400 });
  }

  const targetLocationIds = [...targetLocationMap.keys()];

  // Read from Redis registry (instant)
  const registryCounts = await getRegistryCounts(targetLocationIds);
  const registeredMembers = await getRegisteredMembers(targetLocationIds);

  if (registeredMembers.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: 'registry_empty',
      registryCounts,
      hint: 'Run /api/cron/sms-registry-seed to populate the registry from Boulevard.',
    });
  }

  const candidates = registeredMembers.slice(0, 50).map(m => ({
    clientId: m.clientId || '',
    firstName: m.firstName || '',
    lastName: m.lastName || '',
    email: m.email || '',
    phone: m.phone || '',
    locationName: m.locationName || '',
  }));

  // Call existing pre-appointment endpoint internally
  const endpoint = new URL('/api/sms/automation/pre-appointment', request.url);
  const automationToken = String(process.env.SMS_AUTOMATION_TOKEN || '').trim();
  let automationPayload = {};

  try {
    const automationResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(automationToken ? { 'x-automation-token': automationToken } : {}),
      },
      body: JSON.stringify({
        dryRun: false,
        candidates,
        trigger: 'vercel-cron-sms-upgrade-scan',
        now: new Date().toISOString(),
      }),
      cache: 'no-store',
    });
    automationPayload = await automationResponse.json().catch(() => ({}));

    if (!automationResponse.ok) {
      return NextResponse.json({
        error: 'pre-appointment automation failed',
        status: automationResponse.status,
        candidateCount: candidates.length,
        registryCounts,
        automationPayload,
      }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json({
      error: `pre-appointment fetch failed: ${err.message}`,
      candidateCount: candidates.length,
      registryCounts,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    registryCounts,
    candidateCount: candidates.length,
    automationPayload,
  });
}
