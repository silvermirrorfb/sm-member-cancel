import { Redis } from '@upstash/redis';

// Daily outbound-SMS send counter, used by the sms-health-check cron to
// detect a silent outage (sends dropped to zero) within 24h instead of weeks.
const SENT_KEY_PREFIX = 'sms-sent:';
const SENT_TTL_SECONDS = 3 * 24 * 60 * 60; // keep ~3 days of daily counters
const METRICS_TZ = process.env.SMS_OUTBOUND_TIMEZONE || process.env.SMS_SEND_TIMEZONE || 'America/New_York';

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

// YYYY-MM-DD in the metrics timezone (en-CA formats that way).
export function localDateStr(d = new Date(), timeZone = METRICS_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Bump the counter for "today" (metrics timezone). No-op (returns false) when
// Redis is not configured. Never throws — a metrics failure must not break a send.
export async function incrementDailySendCount(when = new Date()) {
  const redis = getRedis();
  if (!redis) return false;
  const key = `${SENT_KEY_PREFIX}${localDateStr(when)}`;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, SENT_TTL_SECONDS);
    return true;
  } catch (err) {
    console.warn('[sms-metrics] incr failed:', err?.message || err);
    return false;
  }
}

// Returns the recorded send count for a given YYYY-MM-DD, or 0 if unknown / not configured.
export async function getDailySendCount(dateStr) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get(`${SENT_KEY_PREFIX}${dateStr}`);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.warn('[sms-metrics] get failed:', err?.message || err);
    return 0;
  }
}

const CANDIDATE_KEY_PREFIX = 'sms-candidates:';

// Add `by` candidates to today's counter (metrics timezone). No-op when Redis is
// not configured. Never throws. Uses INCRBY because a scan run finds many at once.
export async function incrementDailyCandidateCount(by = 1, when = new Date()) {
  const redis = getRedis();
  if (!redis) return false;
  const n = Number(by);
  if (!Number.isFinite(n) || n <= 0) return false;
  const key = `${CANDIDATE_KEY_PREFIX}${localDateStr(when)}`;
  try {
    const total = await redis.incrby(key, n);
    if (total === n) await redis.expire(key, SENT_TTL_SECONDS);
    return true;
  } catch (err) {
    console.warn('[sms-metrics] candidate incr failed:', err?.message || err);
    return false;
  }
}

export async function getDailyCandidateCount(dateStr) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get(`${CANDIDATE_KEY_PREFIX}${dateStr}`);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.warn('[sms-metrics] candidate get failed:', err?.message || err);
    return 0;
  }
}

const UPGRADE_APPLY_FAILED_KEY_PREFIX = 'sms-upgrade-apply-failed:';

// Bump the counter for Boulevard upgrade-apply rejections "today" (metrics
// timezone). The apply path was previously silent on a Boulevard rejection; this
// makes a run of rejections countable in Redis (read it back with
// getUpgradeApplyFailureCount) instead of disappearing. No-op (returns false)
// when Redis is not configured. Never throws: surfacing a failure must not
// itself become a failure.
export async function incrementUpgradeApplyFailureCount(when = new Date()) {
  const redis = getRedis();
  if (!redis) return false;
  const key = `${UPGRADE_APPLY_FAILED_KEY_PREFIX}${localDateStr(when)}`;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, SENT_TTL_SECONDS);
    return true;
  } catch (err) {
    console.warn('[sms-metrics] upgrade-apply-failure incr failed:', err?.message || err);
    return false;
  }
}

// Returns the recorded upgrade-apply rejection count for a given YYYY-MM-DD, or 0
// if unknown / not configured.
export async function getUpgradeApplyFailureCount(dateStr) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get(`${UPGRADE_APPLY_FAILED_KEY_PREFIX}${dateStr}`);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.warn('[sms-metrics] upgrade-apply-failure get failed:', err?.message || err);
    return 0;
  }
}
