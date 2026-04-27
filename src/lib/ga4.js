// GA4 Measurement Protocol client for the missed-call autotext pilot and
// the membership / voice surfaces.
//
// ─────────────────────────────────────────────────────────────────────────
// EVENT SCHEMA (canonical — this file normalizes camelCase input to match)
// ─────────────────────────────────────────────────────────────────────────
//
// Every event that fires during the missed-call pilot carries, where
// relevant:
//   - location_name        (string, e.g. "brickell")
//   - caller_phone_hash    (SHA-256 hex of E.164, auto-derived from
//                           `caller_phone` / `callerPhone` input)
//   - time_of_day          (0-23, auto-added)
//   - day_of_week          (0=Sun..6=Sat, auto-added)
//
// Event-specific params:
//
//   call_received          + call_sid
//   call_answered          + call_sid, call_duration (seconds)
//   call_missed            + call_sid, dial_call_status (no-answer|busy|failed)
//   auto_text_sent         + call_sid, message_sid, autotext_version
//   auto_text_reply        + call_sid, reply_length, reply_contains_callback_intent
//   auto_text_suppressed   + call_sid, suppression_reason
//                            (kill_switch|not_in_allowlist|on_stop_set|
//                             cooldown|outside_send_window|dedupe)
//   callback_requested     + requested_via
//                            (CALLBACK_keyword|natural_language|AI_inferred)
//
// VC-3 currently emits `auto_text_would_send` as a placeholder for
// `auto_text_sent`; VC-4 will replace the placeholder when the real
// Twilio send is wired up.
//
// ─────────────────────────────────────────────────────────────────────────
// PARAMETER NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────
//
// Existing callers pass camelCase / short names (location, callSid,
// callerPhone, reason). This module aliases them to the snake_case schema
// above so callers don't need to change:
//
//   location, locationName,
//   locationCalled             → location_name
//   callSid                    → call_sid
//   messageSid                 → message_sid
//   dialCallStatus             → dial_call_status
//   callerPhone, caller_phone  → SHA-256 hashed into caller_phone_hash
//                                (raw phone is stripped before send)
//   reason (on auto_text_suppressed) → suppression_reason

import crypto from 'crypto';

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

function isDebugMode() {
  return String(process.env.GA4_DEBUG_MODE || '').trim().toLowerCase() === 'true';
}

function hashPhone(phoneE164) {
  if (!phoneE164) return null;
  return crypto.createHash('sha256').update(String(phoneE164)).digest('hex');
}

function getClientId(phoneE164) {
  if (!phoneE164) return 'anonymous';
  const full = hashPhone(phoneE164);
  return `${full.substring(0, 16)}.${full.substring(16, 32)}`;
}

function getSessionId() {
  return Math.floor(Date.now() / 1000).toString();
}

function normalizeParams(eventName, inputParams) {
  const params = inputParams && typeof inputParams === 'object' ? { ...inputParams } : {};

  // Phone → hash. Strip raw phone in all its input spellings.
  const rawPhone = params.caller_phone || params.callerPhone || null;
  delete params.caller_phone;
  delete params.callerPhone;
  if (rawPhone && !params.caller_phone_hash) {
    params.caller_phone_hash = hashPhone(rawPhone);
  }

  // camelCase / short name aliases → canonical snake_case.
  if (params.location !== undefined && params.location_name === undefined) {
    params.location_name = params.location;
    delete params.location;
  }
  if (params.locationName !== undefined && params.location_name === undefined) {
    params.location_name = params.locationName;
  }
  delete params.locationName;

  if (params.locationCalled !== undefined && params.location_name === undefined) {
    params.location_name = params.locationCalled;
  }
  delete params.locationCalled;

  if (params.callSid !== undefined && params.call_sid === undefined) {
    params.call_sid = params.callSid;
  }
  delete params.callSid;

  if (params.messageSid !== undefined && params.message_sid === undefined) {
    params.message_sid = params.messageSid;
  }
  delete params.messageSid;

  if (params.dialCallStatus !== undefined && params.dial_call_status === undefined) {
    params.dial_call_status = params.dialCallStatus;
  }
  delete params.dialCallStatus;

  // reason → suppression_reason only for the suppressed event.
  if (eventName === 'auto_text_suppressed' && params.reason !== undefined && params.suppression_reason === undefined) {
    params.suppression_reason = params.reason;
    delete params.reason;
  }

  // Auto-added time context, evaluated at send time.
  const now = new Date();
  if (params.time_of_day === undefined) params.time_of_day = now.getHours();
  if (params.day_of_week === undefined) params.day_of_week = now.getDay();

  return { params, clientIdPhone: rawPhone };
}

async function fireGa4Event(eventName, inputParams) {
  const name = String(eventName || '').trim();
  if (!name) return { ok: false, reason: 'empty_event_name' };

  const { GA4_MEASUREMENT_ID, GA4_API_SECRET } = process.env;
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET) {
    console.warn(`[ga4] credentials missing; event not sent: ${name}`);
    return { ok: false, reason: 'credentials_missing' };
  }

  const { params, clientIdPhone } = normalizeParams(name, inputParams);

  const body = {
    client_id: getClientId(clientIdPhone),
    events: [{ name, params: { ...params, session_id: getSessionId() } }],
  };

  const endpoint = isDebugMode() ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT;
  const url = `${endpoint}?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA4_API_SECRET)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (isDebugMode()) {
      try {
        const debugPayload = await response.clone().json();
        const warnings = debugPayload?.validationMessages || [];
        if (Array.isArray(warnings) && warnings.length > 0) {
          console.warn('[ga4] debug validation warnings:', JSON.stringify(warnings));
        }
      } catch (err) {
        // Debug endpoint didn't return JSON; ignore.
      }
    }

    // GA4 returns 204 on success for production, 200 for debug.
    if (!response.ok && response.status !== 204) {
      const text = await response.text().catch(() => '');
      console.error('[ga4] event failed:', response.status, text.slice(0, 200));
      return { ok: false, reason: 'http_error', status: response.status };
    }

    return { ok: true };
  } catch (error) {
    console.error('[ga4] event error:', error?.message || error);
    return { ok: false, reason: 'exception', error: error?.message || String(error) };
  }
}

export { fireGa4Event, hashPhone, normalizeParams, getClientId };
