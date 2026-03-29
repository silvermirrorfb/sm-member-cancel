import crypto from 'crypto';

const SMS_LONG_HARD_MAX_CHARS = 320;
const MAX_SMS_LONG_CHARS = Math.min(
  Math.max(Number(process.env.SMS_MAX_CHARS || SMS_LONG_HARD_MAX_CHARS), 40),
  SMS_LONG_HARD_MAX_CHARS,
);
const TARGET_SMS_LONG_CHARS = Math.min(
  Math.max(Number(process.env.SMS_TARGET_CHARS || MAX_SMS_LONG_CHARS), 40),
  MAX_SMS_LONG_CHARS,
);
const SMS_SHORT_HARD_MAX_CHARS = 150;
const TARGET_SMS_SHORT_CHARS = Math.min(
  Math.max(Number(process.env.SMS_TARGET_SHORT_CHARS || SMS_SHORT_HARD_MAX_CHARS), 40),
  SMS_SHORT_HARD_MAX_CHARS,
);
const BOOKING_URL = 'https://booking.silvermirror.com/booking/location';
const LOCATIONS_URL = 'https://silvermirror.com/locations/';

function stripMarkdownForSms(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeSmsText(text) {
  return stripMarkdownForSms(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKnownSmsUrls(text) {
  let value = String(text || '');
  value = value.replace(/https?:\/\/booking\.silvermirror\.com\/[^\s)]+/gi, BOOKING_URL);
  value = value.replace(/https?:\/\/silvermirror\.com\/locations\/?[^\s)]+/gi, LOCATIONS_URL);
  value = value.replace(/\bbooking\.silvermirror\.com\/[^\s)]+/gi, BOOKING_URL.replace(/^https?:\/\//, ''));
  value = value.replace(/\bsilvermirror\.com\/locations\/?[^\s)]+/gi, LOCATIONS_URL.replace(/^https?:\/\//, ''));
  return value;
}

function rewriteCommonSmsPhrases(text) {
  let value = normalizeKnownSmsUrls(text);
  value = value.replace(/How can I help you today\?/gi, 'How can I help today?');
  value = value.replace(/Whether you have questions about/gi, 'Any questions about');
  value = value.replace(
    /^Hi there!\s*I'm doing well, thank you\.\s*I'm Silver Mirror'?s virtual assistant and I'm here to help with any questions about our facials,\s*services.*$/i,
    "Hi, I'm Silver Mirror's text assistant. Ask me about facials, booking, memberships, or skincare.",
  );
  value = value.replace(
    /^Hello!\s*I'm Silver Mirror's virtual assistant\.\s*I'm here to help with questions about our facials,\s*services,\s*memberships,\s*products,\s*and skincare\.\s*What can I help you with today\?/i,
    "Hi, I'm Silver Mirror's text assistant. Ask me about facials, booking, memberships, or skincare.",
  );
  value = value.replace(
    /^Hi[!. ]+I'm Silver Mirror'?s virtual assistant\.\s*How can I help today\?\s*Any questions about (?:our )?facials,\s*memberships,\s*booking,\s*or skincare advice\??/i,
    "Hi, I'm Silver Mirror's text assistant. Ask me about facials, booking, memberships, or skincare.",
  );
  value = value.replace(
    /^I'd be happy to help you find the perfect facial!\s*You can book online at\s*(?:the following link:?\s*)?(?:https?:\/\/)?booking\.silvermirror\.com\/[^\s)]+.*$/i,
    `Book online at ${BOOKING_URL}`,
  );
  value = value.replace(
    /^I'd be happy to help you find the closest location!\s*We have \d+\s+locations.*$/i,
    `Tell me your neighborhood or ZIP code and I'll suggest the closest location. All locations: ${LOCATIONS_URL}`,
  );
  value = value.replace(
    /^I'd be happy to help you find the closest Silver Mirror location!.*$/i,
    `Tell me your neighborhood or ZIP code and I'll suggest the closest location. All locations: ${LOCATIONS_URL}`,
  );
  value = value.replace(
    /^We have locations in:.*could you let me know what city or area you're in\?.*$/i,
    `Tell me your neighborhood or ZIP code and I'll suggest the closest location. All locations: ${LOCATIONS_URL}`,
  );
  value = value.replace(
    /^Each Silver Mirror location has different hours\..*$/i,
    `Hours vary by location. See ${LOCATIONS_URL} or text me the location name.`,
  );
  value = value.replace(
    /^Great question!\s*For a \d{1,3}-year-old man, I'd recommend the Just for Men Facial\s*\(([^)]+)\)\.?/i,
    'For ingrown hairs or shaving irritation, try the Just for Men Facial. Want booking, pricing, or locations?',
  );
  value = value.replace(
    /^.*Just for Men Facial.*$/i,
    'For ingrown hairs or shaving irritation, try the Just for Men Facial. Want booking, pricing, or locations?',
  );
  value = value.replace(/\s*\n+\s*/g, ' ');
  return value;
}

function trimToWordBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars + 1);
  const breakpoints = [' ', '.', ',', ';', ':', '?', '!'];
  let cut = -1;
  for (const token of breakpoints) cut = Math.max(cut, window.lastIndexOf(token));
  if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
  return text.slice(0, cut).trim();
}

function extractUrlPlaceholders(text) {
  const urls = [];
  const placeholderText = String(text || '').replace(/https?:\/\/[^\s<>"')]+/gi, (match) => {
    const token = `__URL_${urls.length}__`;
    urls.push(match);
    return token;
  });
  return { placeholderText, urls };
}

function restoreUrlPlaceholders(text, urls) {
  let restored = String(text || '');
  urls.forEach((url, index) => {
    restored = restored.replaceAll(`__URL_${index}__`, url);
  });
  return restored;
}

function finalizeTrimmedSmsText(text, urls, maxChars) {
  const restored = restoreUrlPlaceholders(text, urls)
    .replace(/\s+/g, ' ')
    .trim();
  if (restored.length <= maxChars) return restored;
  if (urls.length === 0) {
    return trimToWordBoundary(restored, maxChars)
      .replace(/\b(what|how|which|where|when|why|any|and|or|but|to|for|with|about)$/i, '')
      .replace(/[,:;-]$/, '')
      .trim();
  }

  const presentUrls = urls.filter((url, index) => text.includes(`__URL_${index}__`));
  if (presentUrls.length === 0) {
    return trimToWordBoundary(restored, maxChars)
      .replace(/\b(what|how|which|where|when|why|any|and|or|but|to|for|with|about)$/i, '')
      .replace(/[,:;-]$/, '')
      .trim();
  }

  const primaryUrl = presentUrls[0];
  if (primaryUrl.length >= maxChars) return primaryUrl.slice(0, maxChars);

  const surroundingText = text
    .replace(/__URL_\d+__/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const remainingChars = maxChars - primaryUrl.length - 1;
  if (remainingChars <= 0) return primaryUrl;

  const prefix = trimToWordBoundary(surroundingText, remainingChars)
    .replace(/\b(what|how|which|where|when|why|any|and|or|but|to|for|with|about)$/i, '')
    .replace(/[,:;-]$/, '')
    .trim();
  return prefix ? `${prefix} ${primaryUrl}` : primaryUrl;
}

function trimSmsBodyWithLimits(text, { targetChars, maxChars }) {
  let value = sanitizeSmsText(text);
  value = rewriteCommonSmsPhrases(value);
  if (!value) return '';
  if (value.length <= targetChars) return value;

  const bookingUrlIndex = value.indexOf(BOOKING_URL);
  if (bookingUrlIndex >= 0) {
    const candidate = `Book online: ${BOOKING_URL}`;
    if (candidate.length <= maxChars) return candidate;
  }

  const locationsUrlIndex = value.indexOf(LOCATIONS_URL);
  if (locationsUrlIndex >= 0) {
    const candidate = `Locations and hours: ${LOCATIONS_URL}`;
    if (candidate.length <= maxChars) return candidate;
  }

  const { placeholderText, urls } = extractUrlPlaceholders(value);
  const sentences = placeholderText.match(/[^.!?]+[.!?]?/g) || [placeholderText];
  let compact = '';
  for (const sentenceRaw of sentences) {
    const sentence = sentenceRaw.trim();
    if (!sentence) continue;
    const candidate = compact ? `${compact} ${sentence}` : sentence;
    if (candidate.length > targetChars) break;
    compact = candidate;
  }

  if (compact && compact.length >= Math.min(80, targetChars - 10)) {
    return finalizeTrimmedSmsText(
      compact.replace(/\b(what|how|which|where|when|why|any|and|or|but|to|for|with|about)$/i, '').trim(),
      urls,
      maxChars,
    );
  }

  if (value.length <= maxChars) return value;
  return finalizeTrimmedSmsText(placeholderText, urls, maxChars);
}

function trimSmsBodyLong(text) {
  return trimSmsBodyWithLimits(text, {
    targetChars: TARGET_SMS_LONG_CHARS,
    maxChars: MAX_SMS_LONG_CHARS,
  });
}

function trimSmsBody(text) {
  return trimSmsBodyWithLimits(text, {
    targetChars: TARGET_SMS_SHORT_CHARS,
    maxChars: SMS_SHORT_HARD_MAX_CHARS,
  });
}

function trimSmsBodyShort(text) {
  return trimSmsBody(text);
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
  const safeBody = escapeXml(trimSmsBodyLong(text));
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
  // Fail closed so production never silently skips verification when auth is absent.
  if (!token) return false;
  const provided = String(providedSignature || '').trim();
  if (!provided) return false;
  const expected = computeTwilioSignature(url, params, token);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function sendTwilioSms({ to, body, from, statusCallback, trimBody = trimSmsBody }) {
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
  form.set('Body', trimBody(body));
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
  stripMarkdownForSms,
  sanitizeSmsText,
  trimSmsBody,
  trimSmsBodyLong,
  trimSmsBodyShort,
  buildTwimlMessage,
  parseTwilioFormBody,
  isValidTwilioSignature,
  sendTwilioSms,
};
