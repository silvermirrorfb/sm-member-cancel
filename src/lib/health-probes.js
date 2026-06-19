import { Redis } from '@upstash/redis';

// Live health probes for /api/health?deep=1. These do a real authenticated
// round-trip against each dependency so a broken credential or a down service
// surfaces as an explicit 503 instead of a silent green from an env-presence
// check. Each probe returns { ok, configured, error? } and never throws.

// Redis (Upstash) probe: a real set/get/del round-trip. Redis runs the chat
// sessions, the rate limiter, the daily SMS registry, and the legal STOP list,
// so a Redis outage is a real outage. A failed del() is covered by the short TTL
// on the set, so a probe failure cannot leak probe keys.
export async function probeRedis() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) {
    return { ok: false, configured: false, error: 'UPSTASH_REDIS_REST_URL/TOKEN not set' };
  }
  // Unique value so the read-back proves this probe's own write, not a stale key.
  const nonce = `${process.pid || 'p'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = `health:probe:${nonce}`;
  let redis = null;
  let wrote = false;
  try {
    redis = new Redis({ url, token });
    await redis.set(key, nonce, { ex: 30 });
    wrote = true;
    const readBack = await redis.get(key);
    if (String(readBack) !== nonce) {
      return { ok: false, configured: true, error: 'redis round-trip mismatch' };
    }
    return { ok: true, configured: true };
  } catch (err) {
    return { ok: false, configured: true, error: err?.message || String(err) };
  } finally {
    // Best-effort cleanup even if GET threw after a successful SET, so a partial
    // outage cannot accumulate probe keys. The 30s TTL is the backstop.
    if (wrote && redis) {
      try { await redis.del(key); } catch { /* TTL will reap it */ }
    }
  }
}
