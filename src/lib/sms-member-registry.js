import { Redis } from '@upstash/redis';

const REGISTRY_PREFIX = 'sms-registry:loc:';
const REGISTRY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

async function getRegisteredMembers(canonicalLocationIds) {
  const redis = getRedis();
  if (!redis) return [];
  const members = [];
  for (const locId of canonicalLocationIds) {
    const key = `${REGISTRY_PREFIX}${locId}`;
    let hash = null;
    try { hash = await redis.hgetall(key); } catch (e) { continue; }
    if (!hash || typeof hash !== 'object') continue;
    for (const [clientId, raw] of Object.entries(hash)) {
      try {
        const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
        members.push({ ...member, clientId });
      } catch (e) { /* skip malformed */ }
    }
  }
  return members;
}

async function registerMember(canonicalLocationId, member) {
  const redis = getRedis();
  if (!redis || !canonicalLocationId || !member?.clientId) return false;
  const key = `${REGISTRY_PREFIX}${canonicalLocationId}`;
  const value = JSON.stringify({
    firstName: String(member.firstName || '').trim(),
    lastName: String(member.lastName || '').trim(),
    email: String(member.email || '').trim().toLowerCase(),
    phone: String(member.phone || '').trim(),
    locationName: String(member.locationName || '').trim(),
    updatedAt: new Date().toISOString(),
  });
  try {
    await redis.hset(key, { [member.clientId]: value });
    await redis.expire(key, REGISTRY_TTL_SECONDS);
    return true;
  } catch (e) {
    console.error('[sms-registry] registerMember failed:', e.message);
    return false;
  }
}

async function removeMember(canonicalLocationId, clientId) {
  const redis = getRedis();
  if (!redis || !canonicalLocationId || !clientId) return false;
  try {
    await redis.hdel(`${REGISTRY_PREFIX}${canonicalLocationId}`, clientId);
    return true;
  } catch (e) { return false; }
}

async function removeMemberByPhone(phone) {
  const redis = getRedis();
  if (!redis || !phone) return false;
  const normalizedPhone = String(phone).replace(/\D/g, '');
  if (normalizedPhone.length < 10) return false;

  let cursor = '0';
  let removed = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: `${REGISTRY_PREFIX}*`, count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      const hash = await redis.hgetall(key);
      if (!hash || typeof hash !== 'object') continue;
      for (const [clientId, raw] of Object.entries(hash)) {
        try {
          const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const memberPhone = String(member.phone || '').replace(/\D/g, '');
          if (memberPhone && (memberPhone === normalizedPhone || memberPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(memberPhone))) {
            await redis.hdel(key, clientId);
            removed += 1;
          }
        } catch (e) {}
      }
    }
  } while (cursor !== '0' && cursor !== 0);

  console.log(`[sms-registry] Removed ${removed} entries for phone ${normalizedPhone}`);
  return removed > 0;
}

async function getRegistryCounts(canonicalLocationIds) {
  const redis = getRedis();
  if (!redis) return {};
  const counts = {};
  for (const locId of canonicalLocationIds) {
    try { counts[locId] = await redis.hlen(`${REGISTRY_PREFIX}${locId}`); }
    catch (e) { counts[locId] = 0; }
  }
  return counts;
}

// -----------------------------------------------------------------------------
// STOP set: phone numbers that have opted out via SMS reply.
// This is the authoritative local suppression list. It is checked on EVERY
// outbound send as a belt-and-suspenders safety net, independent of Klaviyo,
// so Klaviyo propagation delay (minutes) cannot cause a send to an opted-out
// number. TCPA compliance requires honoring STOP immediately.
// -----------------------------------------------------------------------------

const STOP_SET_KEY = 'sms-stop-set';

function normalizeStopPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Match the registry's storage format: E.164 without leading 1 for US
  // We store multiple forms to make lookups forgiving.
  return digits;
}

async function addToStopSet(phone) {
  const redis = getRedis();
  if (!redis) return false;
  const norm = normalizeStopPhone(phone);
  if (!norm) return false;
  // Store last 10 digits (US) AND the full normalized string to handle
  // variations like +1 prefix, formatting, etc.
  const entries = new Set([norm, norm.slice(-10)]);
  try {
    for (const e of entries) {
      await redis.sadd(STOP_SET_KEY, e);
    }
    console.log(`[stop-set] Added ${norm.slice(-10)} to suppression set`);
    return true;
  } catch (e) {
    console.warn('[stop-set] Failed to add:', e.message);
    return false;
  }
}

async function isOnStopSet(phone) {
  const redis = getRedis();
  if (!redis) return false;
  const norm = normalizeStopPhone(phone);
  if (!norm) return false;
  const candidates = [norm, norm.slice(-10)];
  try {
    for (const c of candidates) {
      const hit = await redis.sismember(STOP_SET_KEY, c);
      if (hit) return true;
    }
    return false;
  } catch (e) {
    console.warn('[stop-set] Failed to check:', e.message);
    // Fail closed: on Redis error, treat as NOT on stop set (sender will
    // still have the Klaviyo check as backup). Returning true here would
    // block legitimate sends if Redis flaps.
    return false;
  }
}

async function removeFromStopSet(phone) {
  // Used for START reply handling, allows a user to resubscribe
  const redis = getRedis();
  if (!redis) return false;
  const norm = normalizeStopPhone(phone);
  if (!norm) return false;
  try {
    await redis.srem(STOP_SET_KEY, norm);
    await redis.srem(STOP_SET_KEY, norm.slice(-10));
    return true;
  } catch (e) {
    return false;
  }
}

export {
  getRegisteredMembers,
  registerMember,
  removeMember,
  removeMemberByPhone,
  getRegistryCounts,
  REGISTRY_PREFIX,
  addToStopSet,
  isOnStopSet,
  removeFromStopSet,
  STOP_SET_KEY,
};
