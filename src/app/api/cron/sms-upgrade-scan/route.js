export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import {
  canonicalizeBoulevardLocationId,
  getBoulevardAuthContext,
  resolveBoulevardLocationInput,
  scanAppointments,
} from '../../../../lib/boulevard';
import { sendOpsAlertEmail, tallyRunSummary, classifyUpgradeScanRun, buildUpgradeScanAlert } from '../../../../lib/notify';
import { incrementDailyCandidateCount } from '../../../../lib/sms-metrics';
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

// Gate-infrastructure failures: the consent gate could not be evaluated (the
// Klaviyo lookup errored, threw, or returned too many profiles to decide
// safely). These are fail-closed safety stops, NOT legitimate "not subscribed"
// decisions, so a run full of them is unhealthy and must count as errors, not
// skips, or a full Klaviyo outage would report a healthy all-skips run.
const GATE_INFRA_FAILURE_REASONS = new Set([
  'klaviyo_lookup_error',
  'klaviyo_profile_overflow',
  'lookup_failed',
]);

// Non-PII context for error logs: opaque ids and location only, never the
// member's name, email, or phone.
function candidateLogContext(candidate) {
  return {
    clientId: String(candidate?.clientId || '') || null,
    appointmentId: String(candidate?.appointmentId || '') || null,
    location: String(candidate?.locationName || '') || null,
  };
}

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

async function maybeAlertForRun(summary, conditions) {
  const redis = getAlertRedis();
  const hourBucket = new Date().toISOString().slice(0, 13);
  // Per-condition dedup so an early errors alert does not mask a later add-on
  // breach in the same hour. Each condition is rate-limited to once per hour.
  const fresh = [];
  for (const cond of conditions) {
    if (!redis) { fresh.push(cond); continue; }
    const set = await redis.set(`sms-alert:${cond}:${hourBucket}`, '1', { nx: true, ex: 3600 });
    if (set) fresh.push(cond);
  }
  if (fresh.length === 0) return false;
  const { subject, text } = buildUpgradeScanAlert(summary, fresh);
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

// Returns an ARRAY of normalized result rows (one downstream response can carry
// several), so the run summary tallies every row instead of only results[0].
async function checkOneCandidate(candidate, endpoint, automationToken, now) {
  const candidateName = `${candidate.firstName} ${candidate.lastName}`.trim();
  const ctx = candidateLogContext(candidate);
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
      // Capture the response body so a recurring http_500 names its own root
      // cause in the logs the next time it fires, instead of being swallowed.
      let detail = '';
      try {
        if (typeof res.text === 'function') detail = String(await res.text()).slice(0, 500);
      } catch {
        // body already consumed or unavailable; the status alone still logs.
      }
      console.error('[sms-upgrade-scan] candidate request failed', JSON.stringify({ ...ctx, httpStatus: res.status, detail }));
      return [{ candidate: candidateName, status: 'error', reason: `http_${res.status}`, httpStatus: res.status, ok: false }];
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (parseErr) {
      console.error('[sms-upgrade-scan] candidate non-JSON response', JSON.stringify({ ...ctx, httpStatus: res.status, detail: parseErr?.message || 'parse_failed' }));
      return [{ candidate: candidateName, status: 'error', reason: 'non_json_response', httpStatus: res.status, ok: false }];
    }
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    if (rows.length === 0) {
      // The downstream accepted the request but returned no result row for a
      // candidate the cron discovered. That is a pipeline inconsistency, not a
      // healthy skip; surface it as an error rather than the silent 'unknown'
      // bucket that masked the 5-day outbound-sms #10 outage.
      console.error('[sms-upgrade-scan] candidate returned no result rows', JSON.stringify({ ...ctx, httpStatus: res.status }));
      return [{ candidate: candidateName, status: 'error', reason: 'no_result_rows', httpStatus: res.status, ok: false }];
    }
    return rows.map(r => {
      const gateInfraFailure = GATE_INFRA_FAILURE_REASONS.has(String(r.reason || ''));
      if (gateInfraFailure) {
        console.error('[sms-upgrade-scan] consent gate could not be evaluated', JSON.stringify({ ...ctx, reason: r.reason }));
      }
      return {
        candidate: candidateName,
        status: gateInfraFailure ? 'error' : (r.status || 'unknown'),
        reason: r.reason || r.offerKind || null,
        offerKind: r.offerKind || null,
        httpStatus: res.status,
        ok: !gateInfraFailure,
      };
    });
  } catch (err) {
    console.error('[sms-upgrade-scan] candidate evaluation threw', JSON.stringify({ ...ctx, detail: err?.message || String(err) }));
    return [{ candidate: candidateName, status: 'error', reason: err?.message || 'fetch_failed', httpStatus: null, ok: false }];
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

  // Record how many candidates this run found, so the daily health check can word
  // a zero-send day correctly. This is copy-only signal; it never gates the alert.
  await incrementDailyCandidateCount(candidates.length).catch(() => {});

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
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allResults.push(...r.value);
      } else {
        // checkOneCandidate catches internally, so a rejection here should be
        // impossible; log it and count one error rather than abort the run.
        const detail = r.reason?.message || 'rejected';
        console.error('[sms-upgrade-scan] candidate settled as rejected', JSON.stringify({ detail }));
        allResults.push({ candidate: '?', status: 'error', reason: detail, httpStatus: null, ok: false });
      }
    }
    if (i + PARALLEL_BATCH < candidates.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const summary = tallyRunSummary(allResults);

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
  const { shouldAlert, conditions } = classifyUpgradeScanRun(summary);
  if (shouldAlert) {
    await maybeAlertForRun(summary, conditions).catch(err => {
      console.error('[sms-upgrade-scan] inline alert failed:', err?.message || err);
    });
  }
  return NextResponse.json(payload);
}
