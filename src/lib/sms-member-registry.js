import { Redis } from '@upstash/redis';

// Shared PII-lean log masker: anything phone-shaped (8+ digits, with or
// without separators) is masked down to its last 4 before it reaches a log
// line. Used by every catch in this module (a Redis client error can echo the
// full command, which carries the member's number) and imported by the
// webhook route for its send-path and STOP-handler logs. One definition so
// the threshold and format cannot drift.
function maskPhoneDigits(value) {
  return String(value ?? '').replace(/\+?\d[\d\s().-]{6,}\d/g, match => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 8) return match;
    return `***${digits.slice(-4)}`;
  });
}

const REGISTRY_PREFIX = 'sms-registry:loc:';
const REGISTRY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const PHONE_INDEX_KEY = 'sms-registry:phone-index';
// PHONE_INDEX_KEY is a Redis HASH: key = last-10-digit phone, value = JSON
// {clientId, locationId, updatedAt}. Populated by sms-registry-seed cron.
// Used by the Twilio webhook for O(1) phone→clientId resolution so it doesn't
// hit the 15-50s findClientsByPhoneScan path that causes Twilio ERR:11200.

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
    console.error('[sms-registry] registerMember failed:', maskPhoneDigits(e.message));
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

  // Also remove from the phone index so subsequent webhook lookups don't
  // find a stale entry for a number that was just opted out.
  await deletePhoneIndexEntry(phone);

  console.log(`[sms-registry] Removed ${removed} entries for phone ***${normalizedPhone.slice(-4)}`);
  return removed > 0;
}

function normalizePhoneForIndex(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

async function setPhoneIndexEntry(phone, clientId, canonicalLocationId) {
  const redis = getRedis();
  if (!redis) return false;
  const key = normalizePhoneForIndex(phone);
  if (!key || !clientId) return false;
  const value = JSON.stringify({
    clientId,
    locationId: canonicalLocationId || null,
    updatedAt: new Date().toISOString(),
  });
  try {
    await redis.hset(PHONE_INDEX_KEY, { [key]: value });
    return true;
  } catch (e) {
    console.error('[sms-registry] setPhoneIndexEntry failed:', maskPhoneDigits(e.message));
    return false;
  }
}

async function lookupClientIdByPhoneFromIndex(phone) {
  const redis = getRedis();
  if (!redis) return null;
  const key = normalizePhoneForIndex(phone);
  if (!key) return null;
  try {
    const raw = await redis.hget(PHONE_INDEX_KEY, key);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed?.clientId) return null;
    return parsed;
  } catch (e) {
    console.warn('[sms-registry] lookupClientIdByPhoneFromIndex error:', maskPhoneDigits(e.message));
    return null; // fail-open so caller falls through
  }
}

async function deletePhoneIndexEntry(phone) {
  const redis = getRedis();
  if (!redis) return false;
  const key = normalizePhoneForIndex(phone);
  if (!key) return false;
  try {
    await redis.hdel(PHONE_INDEX_KEY, key);
    return true;
  } catch (e) {
    return false;
  }
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
    console.log(`[stop-set] Added ***${norm.slice(-4)} to suppression set`);
    return true;
  } catch (e) {
    console.warn('[stop-set] Failed to add:', maskPhoneDigits(e.message));
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
    console.warn('[stop-set] Failed to check:', maskPhoneDigits(e.message));
    // Fail OPEN: on Redis error, treat as NOT on stop set (sender still has
    // the Klaviyo check as backup). Returning true here would block
    // legitimate sends if Redis flaps. Callers that must fail closed use
    // checkStopSetStrict below.
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

// Strict tri-state stop-set check for callers that must FAIL CLOSED (the
// applied-outcome courtesy follow-up): 'on' | 'off' | 'unknown'. 'off' is
// returned ONLY when Redis affirmatively answered for every candidate key; no
// Redis client, an unnormalizable phone, or any lookup error returns 'unknown',
// never 'off'. The boolean isOnStopSet above keeps its deliberate fail-open
// shape for offer sends (never block a legitimate offer on a Redis flap); do
// not merge the two.
async function checkStopSetStrict(phone) {
  const redis = getRedis();
  if (!redis) return 'unknown';
  const norm = normalizeStopPhone(phone);
  if (!norm) return 'unknown';
  const candidates = [norm, norm.slice(-10)];
  try {
    for (const c of candidates) {
      const hit = await redis.sismember(STOP_SET_KEY, c);
      if (hit) return 'on';
    }
    return 'off';
  } catch (e) {
    console.warn('[stop-set] Strict check failed:', maskPhoneDigits(e.message));
    return 'unknown';
  }
}

// -----------------------------------------------------------------------------
// Applied-outcome follow-up send claim: a durable once-only latch (Redis SET
// NX + TTL) so a double YES or a Twilio webhook redelivery, possibly handled
// by a different serverless instance where in-memory replay state is empty,
// can never send the courtesy follow-up twice.
// -----------------------------------------------------------------------------

const FOLLOWUP_CLAIM_PREFIX = 'sms-followup-claim:';
const FOLLOWUP_CLAIM_TTL_SECONDS = 24 * 60 * 60;

// Returns true ONLY when this call newly claimed the key. false means already
// claimed, no Redis client, an empty key, or a Redis error; the caller treats
// every non-true as already-sent and does not send. Fail closed on doubt,
// matching the checkStopSetStrict posture: a courtesy confirmation is never
// worth a possible double send.
async function claimAppliedFollowupSend(claimKey) {
  const redis = getRedis();
  if (!redis) return false;
  const key = String(claimKey || '').trim();
  if (!key) return false;
  try {
    const result = await redis.set(`${FOLLOWUP_CLAIM_PREFIX}${key}`, new Date().toISOString(), {
      nx: true,
      ex: FOLLOWUP_CLAIM_TTL_SECONDS,
    });
    return result === 'OK';
  } catch (e) {
    console.warn('[followup-claim] Failed to claim:', maskPhoneDigits(e.message));
    return false;
  }
}

// -----------------------------------------------------------------------------
// Apply-mutation claim: a durable once-only guard on the Boulevard WRITE
// itself (SET NX + TTL). Two racing YES deliveries (Twilio redelivery or a
// double YES landing on separate serverless instances before either sees the
// other's pending-offer clear) must not both mutate the same appointment.
// Distinct changes (duration vs add-on, different targets) use distinct keys.
// -----------------------------------------------------------------------------

const APPLY_CLAIM_PREFIX = 'sms-apply-claim:';
// The webhook's maxDuration (300s) is the hard ceiling on any in-flight
// apply; the TTL covers that window with 2x margin so a claim can never
// expire while its apply is still running.
const APPLY_CLAIM_TTL_SECONDS = 600;
// A pending claim older than this cannot still be in flight: 300s maxDuration
// plus margin for clock skew between instances. Shared by every held-claim
// reader (webhook and chat) so the ceiling cannot drift per surface.
const APPLY_INFLIGHT_CEILING_SECONDS = 330;

// One apply-claim key per (appointment, target change), shared by EVERY
// apply call site (the SMS webhook's deferred worker and the chat route's
// inline apply) so racing deliveries across surfaces serialize on the same
// key. Duration upgrades carry their target minutes, add-ons their add-on
// slug, so a genuine second, DIFFERENT change to the same appointment still
// applies while a duplicate of the same change cannot. Segments are
// sanitized so key-space integrity never depends on field provenance.
function buildApplyClaimKey(offer, phone) {
  const offerKind = String(offer?.offerKind || 'duration').toLowerCase();
  const target = offerKind === 'addon'
    ? (String(offer?.addOnName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'addon')
    : String(Number(offer?.targetDurationMinutes) > 0 ? Number(offer.targetDurationMinutes) : 50);
  const appointmentKey = String(offer?.appointmentId || '').trim().replace(/[^A-Za-z0-9_+/=.-]/g, '');
  const scope = appointmentKey
    ? `appt:${appointmentKey}`
    : `phone:${normalizePhoneForIndex(phone) || String(phone || '').trim()}`;
  return `${scope}:${offerKind}:${target}`;
}

// Claim values carry STATE so a later delivery can tell a finished owner
// from one that died between the claim and the Boulevard call: 'pending:'
// at claim time, flipped to 'settled:' once the apply produced an outcome.
const APPLY_CLAIM_PENDING = 'pending:';
const APPLY_CLAIM_SETTLED = 'settled:';

// Tri-state so the caller can tell a duplicate from an outage:
// 'claimed' = this call owns the write and proceeds;
// 'held' = another delivery already owns this exact change (inspect the
// claim state before deciding whether that owner is alive or abandoned);
// 'unavailable' = no Redis client, empty key, or a Redis error. The caller
// must NOT write on 'unavailable' (a concurrent duplicate cannot be ruled
// out) and escalates to a human instead.
async function claimApplyMutation(claimKey) {
  const redis = getRedis();
  if (!redis) return 'unavailable';
  const key = String(claimKey || '').trim();
  if (!key) return 'unavailable';
  try {
    const result = await redis.set(`${APPLY_CLAIM_PREFIX}${key}`, `${APPLY_CLAIM_PENDING}${new Date().toISOString()}`, {
      nx: true,
      ex: APPLY_CLAIM_TTL_SECONDS,
    });
    return result === 'OK' ? 'claimed' : 'held';
  } catch (e) {
    console.warn('[apply-claim] Failed to claim:', maskPhoneDigits(e.message));
    return 'unavailable';
  }
}

// Called by the claim OWNER once the apply produced an outcome (success or
// failure both continue into the route's incident and audit handling). XX +
// keepTtl: only an existing claim is flipped, and the original TTL stands.
async function settleApplyClaim(claimKey) {
  const redis = getRedis();
  if (!redis) return false;
  const key = String(claimKey || '').trim();
  if (!key) return false;
  try {
    const result = await redis.set(`${APPLY_CLAIM_PREFIX}${key}`, `${APPLY_CLAIM_SETTLED}${new Date().toISOString()}`, {
      xx: true,
      keepTtl: true,
    });
    return result === 'OK';
  } catch (e) {
    console.warn('[apply-claim] Failed to settle:', maskPhoneDigits(e.message));
    return false;
  }
}

// Read the claim state for a held key: {state: 'settled'|'pending'|'unknown',
// ageSeconds}. 'unknown' covers no Redis, a missing key (expired between the
// NX and this read), an unparseable value, or a read error; callers treat it
// like an abandoned owner (fail loud, never silently skip).
async function inspectApplyClaim(claimKey) {
  const redis = getRedis();
  if (!redis) return { state: 'unknown', ageSeconds: null };
  const key = String(claimKey || '').trim();
  if (!key) return { state: 'unknown', ageSeconds: null };
  try {
    const raw = await redis.get(`${APPLY_CLAIM_PREFIX}${key}`);
    const value = String(raw || '');
    const state = value.startsWith(APPLY_CLAIM_SETTLED)
      ? 'settled'
      : value.startsWith(APPLY_CLAIM_PENDING) ? 'pending' : 'unknown';
    let ageSeconds = null;
    const stampedAt = new Date(value.slice(value.indexOf(':') + 1)).getTime();
    if (Number.isFinite(stampedAt)) ageSeconds = Math.max(0, (Date.now() - stampedAt) / 1000);
    return { state, ageSeconds };
  } catch (e) {
    console.warn('[apply-claim] Failed to inspect:', maskPhoneDigits(e.message));
    return { state: 'unknown', ageSeconds: null };
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
  checkStopSetStrict,
  removeFromStopSet,
  claimAppliedFollowupSend,
  claimApplyMutation,
  buildApplyClaimKey,
  settleApplyClaim,
  inspectApplyClaim,
  APPLY_INFLIGHT_CEILING_SECONDS,
  maskPhoneDigits,
  STOP_SET_KEY,
  PHONE_INDEX_KEY,
  normalizePhoneForIndex,
  setPhoneIndexEntry,
  lookupClientIdByPhoneFromIndex,
  deletePhoneIndexEntry,
};
