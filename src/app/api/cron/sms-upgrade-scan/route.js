export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import {
  canonicalizeBoulevardLocationId,
  getBoulevardAuthContext,
  resolveBoulevardLocationInput,
  scanAppointments,
} from '../../../../lib/boulevard';
import { sendOpsAlertEmail } from '../../../../lib/notify';
import { getRegistryCounts } from '../../../../lib/sms-member-registry';
import { isWithinSendWindow, getNextWindowStartIso } from '../../../../lib/sms-window';

const SEND_TIMEZONE = process.env.SMS_SEND_TIMEZONE || 'America/New_York';
const SEND_START_HOUR = Number(process.env.SMS_CRON_SEND_START_HOUR || 9);
const SEND_END_HOUR = Number(process.env.SMS_CRON_SEND_END_HOUR || 19);
const DISCOVERY_WINDOW_HOURS = Number(process.env.SMS_CRON_DISCOVERY_WINDOW_HOURS || 24);
const LOCATIONS_PER_RUN = Math.max(1, Number(process.env.SMS_CRON_LOCATIONS_PER_RUN || 2));
const MAX_CANDIDATES_PER_RUN = Math.max(1, Number(process.env.SMS_CRON_MAX_CANDIDATES || 40));
const PARALLEL_BATCH = 5;
const BATCH_DELAY_MS = 5000;

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

// Round-robin: every *10-minute run picks a different slice of the target
// locations so all of them get covered well within the discovery window.
function pickRunLocationIds(allLocationIds, perRun, nowMs = Date.now()) {
  if (allLocationIds.length === 0) return [];
  const slots = Math.max(1, Math.ceil(allLocationIds.length / perRun));
  const slot = Math.floor(nowMs / (10 * 60 * 1000)) % slots;
  return allLocationIds.slice(slot * perRun, slot * perRun + perRun);
}

let cachedAlertRedis = null;
function getAlertRedis() {
  if (cachedAlertRedis) return cachedAlertRedis;
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  cachedAlertRedis = new Redis({ url, token });
  return cachedAlertRedis;
}

async function maybeAlertInlineFailure(summary) {
  const redis = getAlertRedis();
  const hourBucket = new Date().toISOString().slice(0, 13);
  const alertKey = `sms-error-alert:${hourBucket}`;
  if (redis) {
    const set = await redis.set(alertKey, '1', { nx: true, ex: 3600 });
    if (!set) return false;
  }
  const subject = `[Silver Mirror] SMS cron showing HTTP errors with zero sends`;
  const text = [
    `The sms-upgrade-scan cron just completed a run with summary.sent=0 and summary.errors=${summary.errors}.`,
    '',
    `Total candidates: ${summary.total}`,
    `Sent: ${summary.sent}`,
    `Skipped: ${summary.skipped}`,
    `Errors: ${summary.errors}`,
    `errorsByReason: ${JSON.stringify(summary.errorsByReason || {})}`,
    `skippedByReason: ${JSON.stringify(summary.skippedByReason || {})}`,
    `httpStatusCodes: ${JSON.stringify(summary.httpStatusCodes || {})}`,
    '',
    'This alert is rate-limited to once per hour. Check Vercel logs for [sms-upgrade-scan] entries at error level.',
    '',
    'See docs/outbound-sms-system-and-issues.md and QA_ISSUES.md (outbound-sms section).',
  ].join('\n');
  const result = await sendOpsAlertEmail({ subject, text });
  return result?.sent === true;
}

function dedupKeyForAppointment(a) {
  const clientId = String(a?.clientId || '').trim();
  if (clientId) return `c:${clientId}`;
  const phone = String(a?.clientPhone || '').replace(/\D/g, '');
  if (phone) return `p:${phone}`;
  const email = String(a?.clientEmail || '').trim().toLowerCase();
  return email ? `e:${email}` : '';
}

// Build outbound candidates from the appointments scanned at a set of locations.
// Mirrors the "missing firstName/email/phone" filter that
// /api/sms/automation/pre-appointment applies to discovered candidates.
async function discoverCandidates(auth, runLocationMap, nowMs) {
  const cutoffMs = nowMs + DISCOVERY_WINDOW_HOURS * 60 * 60 * 1000;
  const seen = new Set();
  const candidates = [];
  for (const [locId, locName] of runLocationMap.entries()) {
    let scan = null;
    try {
      scan = await scanAppointments(auth.apiUrl, auth.headers, {
        locationId: locId,
        windowStart: new Date(nowMs - 30 * 60 * 1000),
        windowEnd: new Date(cutoffMs),
      });
    } catch (e) {
      continue; // one location's scan failing must not abort the whole run
    }
    const appts = Array.isArray(scan?.appointments) ? scan.appointments : [];
    for (const a of appts) {
      const startMs = new Date(a?.startOn || '').getTime();
      if (!Number.isFinite(startMs) || startMs < nowMs || startMs > cutoffMs) continue;
      const firstName = String(a?.clientFirstName || '').trim();
      const lastName = String(a?.clientLastName || '').trim();
      const email = String(a?.clientEmail || '').trim().toLowerCase();
      const phone = String(a?.clientPhone || '').trim();
      if (!firstName || !lastName || (!email && !phone)) continue;
      const key = dedupKeyForAppointment(a);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        clientId: String(a?.clientId || ''),
        firstName,
        lastName,
        email,
        phone,
        appointmentId: String(a?.id || ''),
        locationName: locName || '',
      });
      if (candidates.length >= MAX_CANDIDATES_PER_RUN) return candidates;
    }
  }
  return candidates;
}

async function checkOneCandidate(candidate, endpoint, automationToken, now) {
  const candidateName = `${candidate.firstName} ${candidate.lastName}`.trim();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(automationToken ? { 'x-automation-token': automationToken } : {}),
      },
      body: JSON.stringify({
        dryRun: false,
        windowHours: DISCOVERY_WINDOW_HOURS,
        candidates: [candidate],
        trigger: 'vercel-cron-sms-upgrade-scan',
        now,
      }),
      cache: 'no-store',
    });
    if (!res.ok) {
      return {
        candidate: candidateName,
        status: 'error',
        reason: `http_${res.status}`,
        httpStatus: res.status,
        ok: false,
      };
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (parseErr) {
      return {
        candidate: candidateName,
        status: 'error',
        reason: 'non_json_response',
        httpStatus: res.status,
        ok: false,
      };
    }
    const r = payload?.results?.[0] || {};
    return {
      candidate: candidateName,
      status: r.status || 'unknown',
      reason: r.reason || r.offerKind || null,
      httpStatus: res.status,
      ok: true,
    };
  } catch (err) {
    return {
      candidate: candidateName,
      status: 'error',
      reason: err?.message || 'fetch_failed',
      httpStatus: null,
      ok: false,
    };
  }
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

  const auth = getBoulevardAuthContext();
  if (!auth) {
    return NextResponse.json({ error: 'Boulevard API credentials are not configured.' }, { status: 500 });
  }

  const nowMs = Date.now();
  const runLocationIds = pickRunLocationIds(targetLocationIds, LOCATIONS_PER_RUN, nowMs);
  const runLocationMap = new Map(runLocationIds.map(id => [id, targetLocationMap.get(id) || '']));

  const [registryCounts, candidates] = await Promise.all([
    getRegistryCounts(targetLocationIds),
    discoverCandidates(auth, runLocationMap, nowMs),
  ]);

  if (candidates.length === 0) {
    const payload = {
      ok: true,
      skipped: 'no_appointments_in_window',
      runLocations: runLocationIds,
      registryCounts,
    };
    console.log('[sms-upgrade-scan]', JSON.stringify(payload));
    return NextResponse.json(payload);
  }

  const automationBaseUrl = String(
    process.env.SMS_AUTOMATION_BASE_URL || 'https://sm-member-cancel.vercel.app',
  ).trim();
  const endpoint = new URL('/api/sms/automation/pre-appointment', automationBaseUrl);
  const automationToken = String(process.env.SMS_AUTOMATION_TOKEN || '').trim();
  const now = new Date().toISOString();

  const allResults = [];
  for (let i = 0; i < candidates.length; i += PARALLEL_BATCH) {
    const batch = candidates.slice(i, i + PARALLEL_BATCH);
    const batchSettled = await Promise.allSettled(
      batch.map(c => checkOneCandidate(c, endpoint, automationToken, now)),
    );
    for (const r of batchSettled) {
      allResults.push(
        r.status === 'fulfilled'
          ? r.value
          : { candidate: '?', status: 'error', reason: r.reason?.message || 'rejected', ok: false },
      );
    }
    if (i + PARALLEL_BATCH < candidates.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const summary = {
    total: allResults.length,
    sent: 0,
    skipped: 0,
    errors: 0,
    skippedByReason: {},
    errorsByReason: {},
    httpStatusCodes: {},
  };
  for (const val of allResults) {
    if (val.httpStatus != null) {
      const code = String(val.httpStatus);
      summary.httpStatusCodes[code] = (summary.httpStatusCodes[code] || 0) + 1;
    }
    if (val.status === 'sent') summary.sent++;
    else if (val.status === 'error' || !val.ok) {
      summary.errors++;
      const reason = val.reason || 'unknown';
      summary.errorsByReason[reason] = (summary.errorsByReason[reason] || 0) + 1;
    } else {
      summary.skipped++;
      const reason = val.reason || 'unknown';
      summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
    }
  }

  const payload = {
    ok: true,
    runLocations: runLocationIds,
    registryCounts,
    candidateCount: candidates.length,
    summary,
    results: allResults,
  };
  const summaryLogPayload = { runLocations: runLocationIds, candidateCount: candidates.length, summary };
  if (summary.errors > 0) {
    console.error('[sms-upgrade-scan]', JSON.stringify(summaryLogPayload));
  } else {
    console.log('[sms-upgrade-scan]', JSON.stringify(summaryLogPayload));
  }
  if (summary.sent === 0 && summary.errors > 0) {
    await maybeAlertInlineFailure(summary).catch(err => {
      console.error('[sms-upgrade-scan] inline alert failed:', err?.message || err);
    });
  }
  return NextResponse.json(payload);
}
