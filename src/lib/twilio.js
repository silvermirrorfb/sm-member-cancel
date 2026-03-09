import crypto from 'crypto';

const MAX_SMS_CHARS = Number(process.env.SMS_MAX_CHARS || 1200);

function trimSmsBody(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= MAX_SMS_CHARS) return value;
  return `${value.slice(0, MAX_SMS_CHARS - 1).trimEnd()}…`;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwimlMessage(text) {
  const safeBody = escapeXml(trimSmsBody(text));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safeBody}</Message></Response>`;
}

function parseTwilioFormBody(rawBody) {
  const params = new URLSearchParams(String(rawBody || ''));
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function computeTwilioSignature(url, params, authToken) {
  const entries = Object.entries(params || {})
    .filter(([k]) => k !== undefined && k !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  let data = String(url || '');
  for (const [k, v] of entries) data += `${k}${v}`;
  return crypto.createHmac('sha1', String(authToken || '')).update(data).digest('base64');
}

function isValidTwilioSignature({ url, params, authToken, providedSignature }) {
  const token = String(authToken || '').trim();
  if (!token) return true;
  const provided = String(providedSignature || '').trim();
  if (!provided) return false;
  const expected = computeTwilioSignature(url, params, token);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function sendTwilioSms({ to, body, from, statusCallback }) {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const fromNumber = String(from || process.env.TWILIO_FROM_NUMBER || '').trim();
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio is not configured. Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER.');
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const form = new URLSearchParams();
  form.set('To', String(to || '').trim());
  form.set('From', fromNumber);
  form.set('Body', trimSmsBody(body));
  if (statusCallback) form.set('StatusCallback', String(statusCallback));

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || `Twilio send failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export {
  trimSmsBody,
  buildTwimlMessage,
  parseTwilioFormBody,
  isValidTwilioSignature,
  sendTwilioSms,
};
