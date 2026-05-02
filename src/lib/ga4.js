// GA4 Measurement Protocol sender.
//
// Wire-up for the missed-call pilot's analytics: every gate decision and
// every send/reply lifecycle event in the missed-call flow fires through
// here so Katie can build dashboards from real data.
//
// Required env vars (set in Vercel project settings):
//   GA4_MEASUREMENT_ID   e.g. "G-XXXXXXXXXX"
//   GA4_API_SECRET       Measurement Protocol API secret
//
// Optional:
//   GA4_DEBUG=1   sends to /debug/mp/collect instead of /mp/collect
//                 (responses include validation errors; nothing is recorded)
//   GA4_DISABLE=1 short-circuits to console-only output without HTTP
//
// The signature is intentionally narrow (eventName, params) so callers
// don't need to construct the GA4 payload shape themselves. We synthesize
// a stable client_id per process to satisfy MP requirements.

import crypto from 'crypto';

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

let cachedClientId = null;

function getClientId() {
  if (cachedClientId) return cachedClientId;
  // GA4 expects a stable client_id (string of digits.digits). Use a
  // deterministic hash of the hostname so the worker process and the
  // Vercel functions both surface as the same "client" in GA4.
  const seed = `${process.env.VERCEL_URL || 'sm-member-cancel'}|${process.pid}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  cachedClientId = `${parseInt(hash.slice(0, 8), 16)}.${parseInt(hash.slice(8, 16), 16)}`;
  return cachedClientId;
}

function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      out[key] = JSON.stringify(value).slice(0, 500);
      continue;
    }
    out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return out;
}

async function fireGa4Event(eventName, params) {
  const name = String(eventName || '').trim();
  if (!name) return;
  const payload = sanitizeParams(params);

  // Always log locally so dev environments without GA4 creds still get
  // observability through `vercel logs` / `pnpm dev` console output.
  console.log('GA4:', name, payload);

  if (process.env.GA4_DISABLE === '1') return;

  const measurementId = String(process.env.GA4_MEASUREMENT_ID || '').trim();
  const apiSecret = String(process.env.GA4_API_SECRET || '').trim();
  if (!measurementId || !apiSecret) {
    // Soft-fail: log a single warning per process, then go quiet so we
    // don't spam the logs in dev environments that intentionally lack creds.
    if (!fireGa4Event._warnedNoCreds) {
      console.warn('[ga4] GA4_MEASUREMENT_ID or GA4_API_SECRET missing; events will not reach GA4.');
      fireGa4Event._warnedNoCreds = true;
    }
    return;
  }

  const endpoint = process.env.GA4_DEBUG === '1' ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT;
  const url = `${endpoint}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const body = JSON.stringify({
    client_id: getClientId(),
    events: [{ name, params: payload }],
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    // Production endpoint returns 204 with empty body. Debug endpoint
    // returns a JSON body with validation results.
    if (process.env.GA4_DEBUG === '1') {
      const debugPayload = await response.json().catch(() => null);
      console.log('[ga4] debug response:', debugPayload);
    } else if (!response.ok) {
      console.warn('[ga4] non-2xx from Measurement Protocol:', response.status);
    }
  } catch (err) {
    // Never let an analytics failure block the missed-call flow.
    console.warn('[ga4] send failed:', err?.message || err);
  }
}

export { fireGa4Event };
