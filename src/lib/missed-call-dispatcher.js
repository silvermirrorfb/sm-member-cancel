import { Redis } from '@upstash/redis';
import { normalizePhone } from './sms-sessions';
import { fireGa4Event } from './ga4';

const DISPATCH_DEDUPE_PREFIX = 'missed-call-dispatched-callsid:';
const COOLDOWN_PREFIX = 'missed-call-cooldown:';

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

// Gates 1-5 land in the next commit.
async function dispatchMissedCallAutotext(payload /* , { now = new Date() } = {} */) {
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

  return { sent: false, reason: 'awaiting_gates_1_5' };
}

export {
  dispatchMissedCallAutotext,
  DISPATCH_DEDUPE_PREFIX,
  COOLDOWN_PREFIX,
};
