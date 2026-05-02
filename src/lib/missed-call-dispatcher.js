import { Redis } from '@upstash/redis';
import { isOnStopSet } from './sms-member-registry';
import { createMissedCallSession, normalizePhone } from './sms-sessions';
import { fireGa4Event } from './ga4';
import { sendTwilioSms } from './twilio';
import { logSmsChatMessages } from './notify';

const MISSED_CALL_AUTOTEXT_TEMPLATE =
  "Hi, we're sorry we missed your call at Silver Mirror {{LOCATION_NAME}}. Our teammate is on the other line. Can our text team help you in the meantime? Reply CALLBACK to request a callback. Reply STOP to opt out.";

const LOCATION_DISPLAY_NAMES = {
  brickell: 'Brickell',
  coral_gables: 'Coral Gables',
  upper_east_side: 'Upper East Side',
  flatiron: 'Flatiron',
  bryant_park: 'Bryant Park',
  manhattan_west: 'Manhattan West',
  upper_west_side: 'Upper West Side',
  dupont_circle: 'Dupont Circle',
  navy_yard: 'Navy Yard',
  penn_quarter: 'Penn Quarter',
};

function formatLocationName(slug) {
  const key = String(slug || '').trim().toLowerCase();
  if (LOCATION_DISPLAY_NAMES[key]) return LOCATION_DISPLAY_NAMES[key];
  if (!key) return 'Silver Mirror';
  return key
    .split(/[_\s-]+/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ''))
    .join(' ')
    .trim() || 'Silver Mirror';
}

const DISPATCH_DEDUPE_PREFIX = 'missed-call-dispatched-callsid:';
const COOLDOWN_PREFIX = 'missed-call-cooldown:';

const DAY_INDEX = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

let cachedRedis = null;
let cachedRedisSignature = '';

function getRedis() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  const signature = `${url}|${token}`;
  if (cachedRedis && cachedRedisSignature === signature) return cachedRedis;
  cachedRedis = new Redis({ url, token });
  cachedRedisSignature = signature;
  return cachedRedis;
}

function getDedupeTtlSeconds() {
  const raw = Number(process.env.MISSED_CALL_CALLSID_DEDUPE_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 86400;
  return Math.floor(raw);
}

function getCooldownSeconds() {
  const minutes = Number(process.env.MISSED_CALL_COOLDOWN_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) return 10 * 60;
  return Math.floor(minutes * 60);
}

function parseAllowlist() {
  const raw = String(process.env.MISSED_CALL_PILOT_LOCATIONS || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  } catch (err) {
    console.warn('[missed-call-dispatcher] MISSED_CALL_PILOT_LOCATIONS is not valid JSON, treating as empty allowlist:', err?.message || err);
  }
  return [];
}

function parseDayRange(range) {
  const parts = String(range || '').split('-').map(s => s.trim());
  if (parts.length === 1) {
    const idx = DAY_INDEX[parts[0]];
    if (idx === undefined) throw new Error(`Unknown day "${parts[0]}"`);
    return [idx];
  }
  const start = DAY_INDEX[parts[0]];
  const end = DAY_INDEX[parts[1]];
  if (start === undefined || end === undefined) {
    throw new Error(`Unknown day in range "${range}"`);
  }
  const days = [];
  if (start <= end) {
    for (let d = start; d <= end; d++) days.push(d);
  } else {
    for (let d = start; d <= 6; d++) days.push(d);
    for (let d = 0; d <= end; d++) days.push(d);
  }
  return days;
}

function parseTimeRange(range) {
  const [startStr, endStr] = String(range || '').split('-').map(s => s.trim());
  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);
  if ([startH, startM, endH, endM].some(n => !Number.isFinite(n))) {
    throw new Error(`Invalid time range "${range}"`);
  }
  return { startMinutes: startH * 60 + startM, endMinutes: endH * 60 + endM };
}

function parseSendWindow(envString) {
  const value = String(envString || '').trim();
  if (!value) return [];
  return value.split(',').map(segment => {
    const trimmed = segment.trim();
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
    if (!match) throw new Error(`Invalid send-window segment "${trimmed}"`);
    const [, dayRange, timeRange, tz] = match;
    return {
      days: parseDayRange(dayRange),
      ...parseTimeRange(timeRange),
      timezone: tz,
    };
  });
}

function computeZonedDayAndMinute(currentInstant, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: String(timezone),
  });
  const parts = fmt.formatToParts(currentInstant instanceof Date ? currentInstant : new Date(currentInstant));
  const weekday = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  const dow = weekday ? DAY_INDEX[weekday] : undefined;
  if (dow === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { dow, minuteOfDay: hour * 60 + minute };
}

function isWithinSendWindow(envString, currentInstant = new Date()) {
  const segments = parseSendWindow(envString);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    const zoned = computeZonedDayAndMinute(currentInstant, segment.timezone);
    if (!zoned) continue;
    if (!segment.days.includes(zoned.dow)) continue;
    if (segment.endMinutes > segment.startMinutes) {
      if (zoned.minuteOfDay >= segment.startMinutes && zoned.minuteOfDay < segment.endMinutes) return true;
    } else if (segment.endMinutes < segment.startMinutes) {
      if (zoned.minuteOfDay >= segment.startMinutes || zoned.minuteOfDay < segment.endMinutes) return true;
    }
  }
  return false;
}

function sendWindowEnvForLocation(locationSlug) {
  const upper = String(locationSlug || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (!upper) return '';
  return String(process.env[`MISSED_CALL_SEND_WINDOW_${upper}`] || '').trim();
}

async function dispatchMissedCallAutotext(payload, { now = new Date() } = {}) {
  if (!payload || typeof payload !== 'object') {
    return { sent: false, reason: 'invalid_payload' };
  }
  const callSid = String(payload.callSid || '').trim();
  const locationCalled = String(payload.locationCalled || '').trim().toLowerCase();
  const callerPhoneE164 = normalizePhone(payload.callerPhone);

  if (!callSid || !locationCalled || !callerPhoneE164) {
    return { sent: false, reason: 'invalid_payload' };
  }

  const ga4Base = { callSid, locationCalled, callerPhone: callerPhoneE164 };
  const redis = getRedis();

  // Gate 0 — CallSid dispatcher dedupe. Distinct from the status-callback
  // dedupe key; prevents the same CallSid from being dispatched twice.
  if (redis) {
    const dedupeKey = `${DISPATCH_DEDUPE_PREFIX}${callSid}`;
    const setResult = await redis.set(dedupeKey, '1', { nx: true, ex: getDedupeTtlSeconds() });
    if (setResult !== 'OK' && setResult !== true) {
      fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'dedupe' }).catch(() => {});
      return { sent: false, reason: 'dedupe' };
    }
  } else {
    console.warn('[missed-call-dispatcher] Redis not configured; Gate 0 dedupe disabled');
  }

  // Gate 1 — master kill switch.
  if (String(process.env.MISSED_CALL_AUTOTEXT_ENABLED || '').trim() !== 'true') {
    fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'kill_switch' }).catch(() => {});
    return { sent: false, reason: 'kill_switch' };
  }

  // Gate 2 — pilot allowlist.
  const allowlist = parseAllowlist();
  if (!allowlist.includes(locationCalled)) {
    fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'not_in_allowlist' }).catch(() => {});
    return { sent: false, reason: 'not_in_allowlist' };
  }

  // Gate 3 — SMS STOP set.
  try {
    if (await isOnStopSet(callerPhoneE164)) {
      fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'on_stop_set' }).catch(() => {});
      return { sent: false, reason: 'on_stop_set' };
    }
  } catch (err) {
    console.warn('[missed-call-dispatcher] stop-set check failed, failing closed:', err?.message || err);
    fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'on_stop_set' }).catch(() => {});
    return { sent: false, reason: 'on_stop_set' };
  }

  // Gate 4 — cooldown.
  if (redis) {
    try {
      const cooldownHit = await redis.get(`${COOLDOWN_PREFIX}${callerPhoneE164}`);
      if (cooldownHit) {
        fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'cooldown' }).catch(() => {});
        return { sent: false, reason: 'cooldown' };
      }
    } catch (err) {
      console.warn('[missed-call-dispatcher] cooldown check failed, failing closed:', err?.message || err);
      fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'cooldown' }).catch(() => {});
      return { sent: false, reason: 'cooldown' };
    }
  }

  // Gate 5 — send window (per-location, timezone-aware).
  const windowEnv = sendWindowEnvForLocation(locationCalled);
  if (!windowEnv) {
    fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'outside_send_window' }).catch(() => {});
    return { sent: false, reason: 'outside_send_window' };
  }
  let inWindow = false;
  try {
    inWindow = isWithinSendWindow(windowEnv, now);
  } catch (err) {
    console.error('[missed-call-dispatcher] send-window parse failed, failing closed:', err?.message || err);
    inWindow = false;
  }
  if (!inWindow) {
    fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'outside_send_window' }).catch(() => {});
    return { sent: false, reason: 'outside_send_window' };
  }

  // All gates passed. Set cooldown FIRST so a transient send-failure does
  // not allow rapid re-attempts. Then send the autotext via Twilio. Boot
  // the missed-call session only after the SMS is on the wire (so a
  // failed send does not leave a session pointing at nothing).
  if (redis) {
    try {
      await redis.set(`${COOLDOWN_PREFIX}${callerPhoneE164}`, '1', { ex: getCooldownSeconds() });
    } catch (err) {
      console.warn('[missed-call-dispatcher] cooldown set failed:', err?.message || err);
    }
  }

  const body = MISSED_CALL_AUTOTEXT_TEMPLATE.replace(
    '{{LOCATION_NAME}}',
    formatLocationName(locationCalled),
  );

  let messageSid = null;
  try {
    const sendResult = await sendTwilioSms({ to: callerPhoneE164, body });
    messageSid = sendResult?.sid || null;
  } catch (err) {
    console.error('[missed-call-dispatcher] sendTwilioSms failed:', err?.message || err);
    fireGa4Event('auto_text_suppressed', { ...ga4Base, reason: 'send_failed' }).catch(() => {});
    return { sent: false, reason: 'send_failed', error: err?.message || String(err) };
  }

  let sessionId = null;
  try {
    sessionId = await createMissedCallSession({
      callSid,
      callerPhone: callerPhoneE164,
      locationCalled,
      outbound_autotext_sid: messageSid,
      timestamp: payload.timestamp || now.toISOString(),
    });
  } catch (err) {
    console.error('[missed-call-dispatcher] createMissedCallSession failed:', err?.message || err);
  }

  // Sheets logging matches the existing outbound logging shape.
  try {
    await logSmsChatMessages([{
      sessionId,
      timestamp: now.toISOString(),
      direction: 'outbound',
      phone: callerPhoneE164,
      content: body,
      offerType: 'missed_call_autotext',
      outcome: 'sent',
      location: locationCalled,
    }]);
  } catch (err) {
    console.warn('[missed-call-dispatcher] sheets log failed:', err?.message || err);
  }

  fireGa4Event('auto_text_sent', { ...ga4Base, sessionId, messageSid }).catch(() => {});

  return { sent: true, sessionId, messageSid };
}

export {
  dispatchMissedCallAutotext,
  parseSendWindow,
  isWithinSendWindow,
  DISPATCH_DEDUPE_PREFIX,
  COOLDOWN_PREFIX,
};
