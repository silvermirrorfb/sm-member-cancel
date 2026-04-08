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

export {
  getRegisteredMembers,
  registerMember,
  removeMember,
  getRegistryCounts,
  REGISTRY_PREFIX,
};
