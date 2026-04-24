import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { isValidTwilioSignature, parseTwilioFormBody } from '../../../../lib/twilio';
import { mapTwilioNumberToLocation } from '../../../../lib/voice-number-map';
import { fireGa4Event } from '../../../../lib/ga4';

const TWIML_HEADERS = { 'Content-Type': 'text/xml; charset=utf-8' };
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const DISPATCH_QUEUE_KEY = 'missed-call-dispatch-queue';
const CALLSID_STATUS_DEDUPE_PREFIX = 'missed-call-callsid:';

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

function resolveLocationForStatus(form) {
  const called = String(form.Called || '').trim();
  if (!called) return null;
  try {
    return mapTwilioNumberToLocation(called);
  } catch (err) {
    console.warn('[voice-status] unknown Called number, falling back to null location:', err?.message || err);
    return null;
  }
}

export async function POST(request) {
  try {
    const rawBody = await request.text();
    const form = parseTwilioFormBody(rawBody);

    const providedSignature = request.headers.get('x-twilio-signature');
    const validSignature = isValidTwilioSignature({
      url: request.url,
      params: form,
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      providedSignature,
    });
    if (!validSignature) {
      return NextResponse.json(
        { error: 'Invalid Twilio signature.' },
        { status: 403 },
      );
    }

    const callSid = String(form.CallSid || '').trim();
    const dialCallStatus = String(form.DialCallStatus || '').trim().toLowerCase();
    const callerPhone = String(form.From || '').trim();
    const location = resolveLocationForStatus(form);

    if (!callSid) {
      console.warn('[voice-status] missing CallSid, cannot dedupe');
      return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
    }

    const redis = getRedis();
    if (redis) {
      const dedupeKey = `${CALLSID_STATUS_DEDUPE_PREFIX}${callSid}`;
      const ttl = getDedupeTtlSeconds();
      const setResult = await redis.set(dedupeKey, '1', { nx: true, ex: ttl });
      if (setResult !== 'OK' && setResult !== true) {
        console.log('[voice-status] dedupe hit for CallSid', callSid);
        return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
      }
    } else {
      console.warn('[voice-status] Upstash not configured; dedupe disabled, duplicate status callbacks may cause double-dispatch');
    }

    const ga4Base = { location, callSid, callerPhone };

    if (dialCallStatus === 'completed') {
      fireGa4Event('call_answered', ga4Base).catch(() => {});
      return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
    }

    if (dialCallStatus === 'no-answer' || dialCallStatus === 'busy' || dialCallStatus === 'failed') {
      fireGa4Event('call_missed', { ...ga4Base, dialCallStatus }).catch(() => {});

      if (!redis) {
        console.error('[voice-status] cannot enqueue dispatch job: Upstash not configured', { callSid });
        return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
      }
      if (!callerPhone || !location) {
        console.error('[voice-status] cannot enqueue dispatch job: missing callerPhone or location', {
          callSid,
          hasCallerPhone: Boolean(callerPhone),
          hasLocation: Boolean(location),
        });
        return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
      }

      const payload = {
        callSid,
        callerPhone,
        locationCalled: location,
        timestamp: new Date().toISOString(),
      };
      try {
        await redis.lpush(DISPATCH_QUEUE_KEY, JSON.stringify(payload));
      } catch (err) {
        console.error('[voice-status] dispatch enqueue failed:', err?.message || err);
      }
      return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
    }

    fireGa4Event('call_status_other', { ...ga4Base, status: dialCallStatus || 'unknown' }).catch(() => {});
    return new NextResponse(EMPTY_TWIML, { status: 200, headers: TWIML_HEADERS });
  } catch (err) {
    console.error('[voice-status] unexpected error:', err?.message || err);
    return new NextResponse(EMPTY_TWIML, { status: 500, headers: TWIML_HEADERS });
  }
}
