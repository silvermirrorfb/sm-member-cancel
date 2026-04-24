// GA4 Measurement Protocol client — core implementation.
// VC-8 scope: replace the VC-1 console.log skeleton with a real
// Measurement Protocol send. Phone-based client_id derivation (caller
// cohorts) and debug-mode validation land in the next two commits.

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

function normalizeParams(eventName, inputParams) {
  const params = inputParams && typeof inputParams === 'object' ? { ...inputParams } : {};

  // Strip raw phone from payload. This commit does not yet emit a hash —
  // Measurement Protocol will therefore see events without a per-user
  // key until the next commit lands. Raw PII must never ship.
  delete params.caller_phone;
  delete params.callerPhone;

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

  if (eventName === 'auto_text_suppressed' && params.reason !== undefined && params.suppression_reason === undefined) {
    params.suppression_reason = params.reason;
    delete params.reason;
  }

  const now = new Date();
  if (params.time_of_day === undefined) params.time_of_day = now.getHours();
  if (params.day_of_week === undefined) params.day_of_week = now.getDay();

  return params;
}

async function fireGa4Event(eventName, inputParams) {
  const name = String(eventName || '').trim();
  if (!name) return { ok: false, reason: 'empty_event_name' };

  const { GA4_MEASUREMENT_ID, GA4_API_SECRET } = process.env;
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET) {
    console.warn(`[ga4] credentials missing; event not sent: ${name}`);
    return { ok: false, reason: 'credentials_missing' };
  }

  const params = normalizeParams(name, inputParams);

  const body = {
    client_id: 'anonymous',
    events: [{ name, params }],
  };

  const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA4_API_SECRET)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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

export { fireGa4Event };
