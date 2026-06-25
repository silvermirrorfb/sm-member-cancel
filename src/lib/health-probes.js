import { Redis } from '@upstash/redis';
import { parseGoogleServiceAccount } from './google-credentials.js';

// Live health probes for /api/health?deep=1. These do a real authenticated
// round-trip against each dependency so a broken credential or a down service
// surfaces as an explicit 503 instead of a silent green from an env-presence
// check. Each probe returns { ok, configured, error? } and never throws.

// Per-probe wall-clock cap so a hung dependency cannot stall the health
// endpoint, and so a single probe stays a single cheap call (rate-safe).
const PROBE_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS || 5000);

function probeError(err) {
  if (err?.name === 'AbortError') return 'timeout';
  return err?.message || String(err);
}

// Runs a probe body under a hard wall-clock deadline that covers the ENTIRE
// operation: connect + headers + body read for fetch probes, and token exchange
// + request for the Sheets probe. A per-fetch abort timer that clears once
// headers arrive would NOT bound a slow body read or a stalled auth handshake,
// so the deep route's Promise.all could hang. The AbortController is handed to
// the body so fetch-based probes also tear down the live socket on deadline;
// probes that ignore the signal simply lose the race and their dangling work is
// discarded (the route already has its result). Never throws.
async function runProbe(body) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, configured: true, error: 'timeout' });
    }, PROBE_TIMEOUT_MS);
  });
  const work = Promise.resolve()
    .then(() => body(controller.signal))
    .catch((err) => ({ ok: false, configured: true, error: probeError(err) }));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
    return { ok: false, configured: true, error: probeError(err) };
  } finally {
    // Best-effort cleanup even if GET threw after a successful SET, so a partial
    // outage cannot accumulate probe keys. The 30s TTL is the backstop.
    if (wrote && redis) {
      try { await redis.del(key); } catch { /* TTL will reap it */ }
    }
  }
}

// Boulevard probe: a tiny authenticated GraphQL query (`__typename`). The admin
// API gateway requires the Basic blvd-admin-v1 auth header, so a bad credential
// returns 401 here instead of silently passing the env-presence check. boulevard.js
// is lazy-imported so the default (non-deep) health path stays light; the import
// and auth build run inside runProbe so any throw is caught (matches probeSheets).
export async function probeBoulevard() {
  return runProbe(async (signal) => {
    const { getBoulevardAuthContext } = await import('./boulevard.js');
    const auth = getBoulevardAuthContext();
    if (!auth) {
      return { ok: false, configured: false, error: 'BOULEVARD_API_KEY/SECRET/BUSINESS_ID not set' };
    }
    const res = await fetch(auth.apiUrl, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ query: 'query HealthProbe { __typename }' }),
      signal,
    });
    if (!res.ok) return { ok: false, configured: true, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (data?.errors) return { ok: false, configured: true, error: 'graphql error' };
    if (!data?.data?.__typename) return { ok: false, configured: true, error: 'unexpected response' };
    return { ok: true, configured: true };
  });
}

// Twilio probe: GET the account resource (a credential check, no SMS sent, no
// spend). A bad SID/token returns 401.
export async function probeTwilio() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!sid || !token) {
    return { ok: false, configured: false, error: 'TWILIO_ACCOUNT_SID/AUTH_TOKEN not set' };
  }
  return runProbe(async (signal) => {
    const basic = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      method: 'GET',
      headers: { Authorization: `Basic ${basic}` },
      signal,
    });
    if (!res.ok) return { ok: false, configured: true, error: `HTTP ${res.status}` };
    return { ok: true, configured: true };
  });
}

// Klaviyo probe: GET /profiles/?page[size]=1. This is the exact endpoint and
// `profiles:read` scope the production TCPA consent gate depends on (klaviyo.js
// reads /profiles/), so it authenticates the credential AND the permission that
// matters. Probing /accounts/ instead could 403-false-degrade a least-privilege
// key that has profiles:read but not accounts:read. A bad key returns 401/403.
export async function probeKlaviyo() {
  const apiKey = String(process.env.KLAVIYO_PRIVATE_API_KEY || '').trim();
  const baseUrl = String(process.env.KLAVIYO_API_BASE_URL || 'https://a.klaviyo.com/api').trim().replace(/\/+$/, '');
  const revision = String(process.env.KLAVIYO_REVISION || '2026-01-15').trim();
  if (!apiKey) {
    return { ok: false, configured: false, error: 'KLAVIYO_PRIVATE_API_KEY not set' };
  }
  return runProbe(async (signal) => {
    const url = new URL(`${baseUrl}/profiles/`);
    url.searchParams.set('page[size]', '1');
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision,
        accept: 'application/json',
      },
      signal,
    });
    if (!res.ok) return { ok: false, configured: true, error: `HTTP ${res.status}` };
    return { ok: true, configured: true };
  });
}

// Google Sheets probe: read the configured spreadsheet's metadata (readonly
// scope, fields=spreadsheetId, so it is a minimal call). This confirms both that
// the service-account JSON is valid AND that it can reach the sheet. googleapis
// is lazy-imported so it never loads on the default health path.
export async function probeSheets() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const spreadsheetId = String(process.env.GOOGLE_SHEET_ID || '').trim();
  if (!credentials || !spreadsheetId) {
    return { ok: false, configured: false, error: 'GOOGLE_SERVICE_ACCOUNT_JSON/GOOGLE_SHEET_ID not set' };
  }
  // runProbe bounds the WHOLE body, including the GoogleAuth token exchange (which
  // the per-request gaxios timeout below does not cover). signal is also handed to
  // gaxios so the metadata request is torn down on deadline.
  return runProbe(async (signal) => {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: parseGoogleServiceAccount(credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.get(
      { spreadsheetId, fields: 'spreadsheetId' },
      { timeout: PROBE_TIMEOUT_MS, signal },
    );
    return { ok: true, configured: true };
  });
}
