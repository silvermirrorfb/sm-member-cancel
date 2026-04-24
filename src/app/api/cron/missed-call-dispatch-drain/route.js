import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { dispatchMissedCallAutotext } from '../../../../lib/missed-call-dispatcher';

export const maxDuration = 60;

const DISPATCH_QUEUE_KEY = 'missed-call-dispatch-queue';
const MAX_BATCH = 10;

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

function parseJob(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    console.warn('[missed-call-drain] skipping unparseable job:', err?.message || err);
    return null;
  }
}

async function popJobs(redis, count) {
  try {
    const popped = await redis.lpop(DISPATCH_QUEUE_KEY, count);
    if (!popped) return [];
    if (Array.isArray(popped)) return popped;
    return [popped];
  } catch (err) {
    const single = [];
    try {
      for (let i = 0; i < count; i++) {
        const one = await redis.lpop(DISPATCH_QUEUE_KEY);
        if (!one) break;
        single.push(one);
      }
    } catch (innerErr) {
      console.error('[missed-call-drain] lpop fallback failed:', innerErr?.message || innerErr);
      throw err;
    }
    return single;
  }
}

export async function POST(request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: 'upstash_not_configured', processed: 0, results: [] },
      { status: 503 },
    );
  }

  let rawJobs = [];
  try {
    rawJobs = await popJobs(redis, MAX_BATCH);
  } catch (err) {
    console.error('[missed-call-drain] queue pop failed:', err?.message || err);
    return NextResponse.json({ error: 'queue_pop_failed', message: err?.message || String(err) }, { status: 500 });
  }

  const results = [];
  for (const raw of rawJobs) {
    const job = parseJob(raw);
    if (!job) {
      results.push({ skipped: true, reason: 'unparseable' });
      continue;
    }
    try {
      const result = await dispatchMissedCallAutotext(job);
      results.push({ callSid: job.callSid || null, ...result });
    } catch (err) {
      console.error('[missed-call-drain] dispatch failed:', err?.message || err);
      results.push({ callSid: job.callSid || null, error: err?.message || String(err) });
    }
  }

  return NextResponse.json({ processed: results.length, results }, { status: 200 });
}
