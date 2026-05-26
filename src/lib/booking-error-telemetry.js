import { Redis } from '@upstash/redis';
import * as Sentry from '@sentry/nextjs';

// ----------------------------------------------------------------------------
// Booking-error telemetry
// ----------------------------------------------------------------------------
//
// Why this exists:
//   Six distinct sessions in the 2026-05-20 to 2026-05-26 log review hit real
//   booking-system bugs (payment failures, broken promo codes, wrong phone
//   numbers, etc.). The bot correctly routed them to (888) 677-0055 or
//   hello@, but engineering had zero signal — we found out by manually
//   reviewing the chat log a week later. See CHATBOT_FOLLOWUPS_2026-05-26.md
//   item 1.
//
// What this does:
//   On every inbound user message, run a regex classifier across the six
//   symptom categories. On a hit, fire a Sentry "warning" event with the
//   session ID, the (PII-scrubbed) user message, and the symptom subcategory.
//   Bot user-facing response is unchanged — the firing is silent.
//
// Why regex (not an LLM classifier):
//   - Deterministic, fast, testable
//   - Symptom list is small and well-defined
//   - LLM classifier would add a Claude call per message (cost + latency)
//   - False-positive cost is low (Sentry warning, not a page)
//
// Rate limiting:
//   1 event per session per subcategory per hour. If a session repeats the
//   same symptom 10 times, engineering sees one event. A different
//   subcategory in the same session still fires.
//
// PII redaction:
//   - Phone numbers and emails scrubbed from user_message via regex
//   - We never include session.memberProfile.first_name / last_name in the
//     event payload (name fields are simply omitted)
//   - session_id (UUID) is included; engineers can correlate to the chat
//     transcript in Google Sheets if they need full context
// ----------------------------------------------------------------------------

export const SUBCATEGORIES = Object.freeze({
  PROMO_CODE: 'promo_code',
  REFERRAL_CODE: 'referral_code',
  CARD_PAYMENT: 'card_payment',
  CANT_BOOK: 'cant_book',
  WRONG_PHONE_NUMBER: 'wrong_phone_number',
  SITE_DOWN: 'site_down',
});

const SUBCATEGORY_VALUES = new Set(Object.values(SUBCATEGORIES));

// Order matters: more-specific patterns are checked first. The first match wins.
// Each entry is { subcategory, patterns: RegExp[] }.
const DETECTORS = [
  {
    subcategory: SUBCATEGORIES.REFERRAL_CODE,
    // "referral code" must co-occur with a failure verb. Match either order
    // and tolerate up to ~40 chars of intervening text.
    patterns: [
      /referral code[\s\S]{0,40}(invalid|not working|won'?t apply|isn'?t working|wouldn'?t apply|didn'?t apply|did not apply)/i,
      /(invalid|not working|won'?t apply|isn'?t working|wouldn'?t apply|didn'?t apply|did not apply)[\s\S]{0,40}referral code/i,
    ],
  },
  {
    subcategory: SUBCATEGORIES.PROMO_CODE,
    patterns: [
      /promo code (is )?invalid/i,
      /promo code (is )?not working/i,
      /promo code (doesn'?t|does not) work/i,
      /\bcode (is )?(invalid|not working)\b/i,
      /\b(code|promo) (isn'?t|is not) (working|valid)\b/i,
    ],
  },
  {
    subcategory: SUBCATEGORIES.CARD_PAYMENT,
    patterns: [
      /\bcard (is )?(rejected|declined|denied)\b/i,
      /\bcard keeps (getting )?(rejected|declined|denied)\b/i,
      /\bpayment (failed|failing|not working|declined|rejected)\b/i,
      /\b(credit )?card (won'?t|wont|will not) (go through|process|work)\b/i,
      /\bcharge (declined|rejected|failed)\b/i,
    ],
  },
  {
    subcategory: SUBCATEGORIES.CANT_BOOK,
    patterns: [
      // Allow up to 3 intervening words ("can't I book", "can't seem to book",
      // "won't let me book", "cannot easily book"). Bounded so we don't match
      // "I can't go to your store unless I book a hotel" style false positives.
      /\b(can'?t|cant|cannot|won'?t|wont|will not) (\w+ ){0,3}book\b/i,
      /\b(unable to|trouble) book(ing)?\b/i,
      /\bbooking (page|site|widget) (broken|not working|down|frozen)\b/i,
    ],
  },
  {
    subcategory: SUBCATEGORIES.WRONG_PHONE_NUMBER,
    // "wrong number" in a BOOKING context. Address context excluded by
    // a negative-lookahead-ish check in the detector function below.
    patterns: [
      /\b(it (says|shows)|i (got|see)) (a )?wrong (phone )?number\b/i,
      /\bthe (phone )?number (is|listed is) wrong\b/i,
      /\bphone number doesn'?t work\b/i,
    ],
  },
  {
    subcategory: SUBCATEGORIES.SITE_DOWN,
    patterns: [
      /\b(website|site|page) (is )?(not working|down|broken|won'?t load|wont load|won'?t open|wouldn'?t load)\b/i,
      /\b(site|website|page|booking) (page )?(crashed|frozen|froze)\b/i,
    ],
  },
];

// Words that indicate the "wrong number" mention is about a STREET ADDRESS,
// not a booking phone-number issue. If any of these co-occur within 30 chars
// of the "wrong number" match, the WRONG_PHONE_NUMBER detector is suppressed.
const ADDRESS_CONTEXT_RE =
  /\b(address|street|st\.?|avenue|ave\.?|road|rd\.?|building|apt|apartment|unit|floor|zip code|postal code)\b/i;

/**
 * Returns { subcategory } if the user message matches a known booking-error
 * symptom, else null. Pure function; no side effects.
 */
export function detectBookingError(rawMessage) {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return null;
  const message = rawMessage;
  for (const detector of DETECTORS) {
    for (const pat of detector.patterns) {
      const match = pat.exec(message);
      if (!match) continue;
      // Address-context suppression for the wrong-phone-number detector.
      if (detector.subcategory === SUBCATEGORIES.WRONG_PHONE_NUMBER) {
        const start = Math.max(0, match.index - 30);
        const end = Math.min(message.length, match.index + match[0].length + 30);
        const window = message.slice(start, end);
        if (ADDRESS_CONTEXT_RE.test(window)) continue;
      }
      return { subcategory: detector.subcategory };
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// PII scrubbing
// ----------------------------------------------------------------------------

const PHONE_RE =
  /(\+?\d{1,2}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/**
 * Strips phone numbers and email addresses from a free-form text field.
 * Names typed by the user in free-form text are not scrubbed (too brittle to
 * detect reliably); name FIELDS from the session profile are simply not
 * included in the event payload. See PII rules in the file header.
 */
export function scrubPII(text) {
  if (typeof text !== 'string') return '';
  return text.replace(PHONE_RE, '[redacted-phone]').replace(EMAIL_RE, '[redacted-email]');
}

// ----------------------------------------------------------------------------
// Redis rate-limit
// ----------------------------------------------------------------------------

const RATE_LIMIT_KEY_PREFIX = 'chatbot-booking-error-fired';
const RATE_LIMIT_TTL_SECONDS = 60 * 60; // 1 hour

let cachedRedis = null;
let cachedRedisSignature = '';

function getRedis() {
  // Test hook takes priority: when __setRedisForTests has installed a stub,
  // use it regardless of env. Without this, tests that don't set
  // UPSTASH_REDIS_REST_URL would hit the fail-open path and bypass the stub.
  if (cachedRedis && cachedRedisSignature === 'test-stub') return cachedRedis;
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  const signature = `${url}|${token}`;
  if (cachedRedis && cachedRedisSignature === signature) return cachedRedis;
  cachedRedis = new Redis({ url, token });
  cachedRedisSignature = signature;
  return cachedRedis;
}

/**
 * SETNX-with-TTL semantics: returns true on the first call for a given
 * (session, subcategory) within the TTL window, false on subsequent calls.
 *
 * When Redis is not configured, we conservatively allow the event to fire
 * (fail-open) — a missing dedup window is better than silently dropping a
 * production-bug signal. In tests, Redis is mocked via the
 * `__setRedisForTests` hook below.
 */
async function shouldFireForSession(sessionId, subcategory) {
  const redis = getRedis();
  if (!redis) return true; // fail-open
  const key = `${RATE_LIMIT_KEY_PREFIX}:${sessionId}:${subcategory}`;
  try {
    // Upstash Redis `set` with NX + EX returns "OK" on success, null on
    // collision. We only fire when we set the key (first time).
    const result = await redis.set(key, '1', { nx: true, ex: RATE_LIMIT_TTL_SECONDS });
    return result === 'OK';
  } catch (err) {
    // Don't let telemetry break the chat handler.
    console.error('booking-error-telemetry: Redis rate-limit check failed', err);
    return true; // fail-open
  }
}

// Test hook: swap the cached Redis instance.
export function __setRedisForTests(stub) {
  if (stub === null) {
    cachedRedis = null;
    cachedRedisSignature = '';
    return;
  }
  cachedRedis = stub;
  cachedRedisSignature = 'test-stub';
}

// Sentry's namespace is fully populated at runtime inside Next.js (via
// instrumentation.js) but not necessarily when this module is imported from a
// standalone Node context (e.g., a smoke-test script). Resolve lazily so the
// module loads cleanly in either environment, and no-op silently if Sentry is
// inert (e.g., SENTRY_DSN not set).
function defaultCaptureMessage(msg, opts) {
  const fn = Sentry && typeof Sentry.captureMessage === 'function' ? Sentry.captureMessage : null;
  if (fn) return fn.call(Sentry, msg, opts);
  return null;
}

let captureMessageFn = defaultCaptureMessage;
export function __setCaptureMessageForTests(fn) {
  captureMessageFn = typeof fn === 'function' ? fn : defaultCaptureMessage;
}

// ----------------------------------------------------------------------------
// Event firing
// ----------------------------------------------------------------------------

/**
 * Records a booking-error event to Sentry, subject to rate-limiting and
 * PII scrubbing. Never throws — telemetry must not break the chat handler.
 *
 * @param {object} args
 * @param {string} args.sessionId - the chat session UUID (safe; included)
 * @param {string} args.userMessage - the inbound user message (PII-scrubbed)
 * @param {string} [args.botResponse] - the bot's reply text (PII-scrubbed)
 * @param {string|null} [args.location] - optional location string
 * @param {string} args.subcategory - one of SUBCATEGORIES values
 * @returns {Promise<{ fired: boolean, reason?: string }>}
 */
export async function recordBookingError({
  sessionId,
  userMessage,
  botResponse,
  location,
  subcategory,
}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { fired: false, reason: 'no-session-id' };
  }
  if (!SUBCATEGORY_VALUES.has(subcategory)) {
    return { fired: false, reason: 'invalid-subcategory' };
  }
  try {
    const allowed = await shouldFireForSession(sessionId, subcategory);
    if (!allowed) {
      return { fired: false, reason: 'rate-limited' };
    }
    const extras = {
      session_id: sessionId,
      user_message: scrubPII(userMessage || ''),
      bot_response: scrubPII(botResponse || ''),
      timestamp: new Date().toISOString(),
    };
    if (location && typeof location === 'string') {
      extras.location = location;
    }
    captureMessageFn('chatbot.booking_error_detected', {
      level: 'warning',
      tags: {
        category: 'booking_error',
        subcategory,
      },
      extra: extras,
    });
    return { fired: true };
  } catch (err) {
    console.error('booking-error-telemetry: recordBookingError failed', err);
    return { fired: false, reason: 'error' };
  }
}
