import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectBookingError,
  scrubPII,
  recordBookingError,
  extractLocationFromMessage,
  SUBCATEGORIES,
  __setRedisForTests,
  __setCaptureMessageForTests,
} from '../src/lib/booking-error-telemetry.js';

// ----------------------------------------------------------------------------
// Detection — one case per symptom category (acceptance criterion #5, #9.1)
// ----------------------------------------------------------------------------

describe('detectBookingError: one match per symptom category', () => {
  it('detects PROMO_CODE for "promo code invalid"', () => {
    expect(detectBookingError('My promo code invalid?')).toEqual({
      subcategory: SUBCATEGORIES.PROMO_CODE,
    });
  });

  it('detects PROMO_CODE for "code not working"', () => {
    expect(detectBookingError("the code is not working")).toEqual({
      subcategory: SUBCATEGORIES.PROMO_CODE,
    });
  });

  it('detects REFERRAL_CODE for "referral code won\'t apply"', () => {
    expect(detectBookingError("my referral code won't apply at checkout")).toEqual({
      subcategory: SUBCATEGORIES.REFERRAL_CODE,
    });
  });

  it('detects CARD_PAYMENT for "card keeps getting rejected"', () => {
    expect(
      detectBookingError('My credit card keeps getting rejected when all the information is accurate'),
    ).toEqual({ subcategory: SUBCATEGORIES.CARD_PAYMENT });
  });

  it('detects CARD_PAYMENT for "card declined"', () => {
    expect(detectBookingError('Card declined three times')).toEqual({
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
  });

  it('detects CARD_PAYMENT for "payment failed"', () => {
    expect(detectBookingError('Payment failed when I tried to book')).toEqual({
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
  });

  it('detects CANT_BOOK for "can\'t book"', () => {
    expect(detectBookingError("Why can't I book?")).toEqual({
      subcategory: SUBCATEGORIES.CANT_BOOK,
    });
  });

  it('detects CANT_BOOK for "won\'t let me book"', () => {
    expect(detectBookingError("The site won't let me book today")).toEqual({
      subcategory: SUBCATEGORIES.CANT_BOOK,
    });
  });

  it('detects WRONG_PHONE_NUMBER for "it says wrong number" without address context', () => {
    expect(detectBookingError("It says wrong number")).toEqual({
      subcategory: SUBCATEGORIES.WRONG_PHONE_NUMBER,
    });
  });

  it('does NOT detect WRONG_PHONE_NUMBER when "wrong number" is in an address context', () => {
    // Suppression: a street address mention near "wrong number" rules this out.
    expect(
      detectBookingError("My address has the wrong street number — it should be 123 Main"),
    ).toBeNull();
    expect(detectBookingError('Wrong number on the building, I meant unit 4B')).toBeNull();
  });

  it('detects SITE_DOWN for "website not working"', () => {
    expect(detectBookingError('Your website is not working')).toEqual({
      subcategory: SUBCATEGORIES.SITE_DOWN,
    });
    expect(detectBookingError("the site won't load")).toEqual({
      subcategory: SUBCATEGORIES.SITE_DOWN,
    });
  });

  it('returns null for unrelated messages', () => {
    expect(detectBookingError('What are your hours?')).toBeNull();
    expect(detectBookingError("I'd like to upgrade my membership.")).toBeNull();
    expect(detectBookingError('')).toBeNull();
    expect(detectBookingError(null)).toBeNull();
    expect(detectBookingError(undefined)).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Location extraction (codex P2 #3 follow-up per Matt 2026-05-26)
// ----------------------------------------------------------------------------

describe('extractLocationFromMessage', () => {
  it('extracts "Flatiron" from "Flatiron promo code invalid"', () => {
    expect(extractLocationFromMessage('Flatiron promo code invalid')).toBe('Flatiron');
  });

  it('extracts "Upper East Side" from "Why won\'t UES let me book"', () => {
    expect(extractLocationFromMessage("Why won't UES let me book")).toBe('Upper East Side');
    expect(extractLocationFromMessage('UWS site is broken')).toBe('Upper West Side');
  });

  it('returns null when no location is mentioned', () => {
    expect(extractLocationFromMessage('My card was declined')).toBeNull();
    expect(extractLocationFromMessage('promo code invalid')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(extractLocationFromMessage('FLATIRON site is down')).toBe('Flatiron');
    expect(extractLocationFromMessage('the bryant park widget is broken')).toBe('Bryant Park');
  });

  it('matches every documented location alias', () => {
    expect(extractLocationFromMessage('Bryant Park promo code invalid')).toBe('Bryant Park');
    expect(extractLocationFromMessage('Manhattan West site down')).toBe('Manhattan West');
    expect(extractLocationFromMessage('Coral Gables card declined')).toBe('Coral Gables');
    expect(extractLocationFromMessage('Dupont Circle can\'t book')).toBe('Dupont Circle');
    expect(extractLocationFromMessage('At Dupont my code is invalid')).toBe('Dupont Circle');
    expect(extractLocationFromMessage('Penn Quarter site won\'t load')).toBe('Penn Quarter');
    expect(extractLocationFromMessage('Navy Yard payment failed')).toBe('Navy Yard');
    expect(extractLocationFromMessage('Brickell promo not working')).toBe('Brickell');
  });

  it('returns the FIRST listed location when a message mentions multiple', () => {
    // LOCATION_ALIASES order: Bryant Park > Manhattan West > UES > UWS >
    // Coral Gables > Dupont > Penn Quarter > Navy Yard > Flatiron > Brickell.
    expect(
      extractLocationFromMessage('Bryant Park and Flatiron both have the same issue'),
    ).toBe('Bryant Park');
  });

  it('returns null on empty / non-string input', () => {
    expect(extractLocationFromMessage('')).toBeNull();
    expect(extractLocationFromMessage(null)).toBeNull();
    expect(extractLocationFromMessage(undefined)).toBeNull();
    expect(extractLocationFromMessage(123)).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// PII scrubbing (acceptance criterion #9.4)
// ----------------------------------------------------------------------------

describe('scrubPII', () => {
  it('redacts US phone numbers in common formats', () => {
    expect(scrubPII('Call me at 888-512-7546')).toContain('[redacted-phone]');
    expect(scrubPII('My number is (212) 555-1234')).toContain('[redacted-phone]');
    expect(scrubPII('Reach me at 212.555.1234 or 2125551234')).toMatch(/\[redacted-phone\][^0-9]+\[redacted-phone\]/);
    expect(scrubPII('+1 888 677 0055')).toContain('[redacted-phone]');
  });

  it('redacts email addresses', () => {
    expect(scrubPII('Email me at jane.doe@example.com please')).toContain('[redacted-email]');
    expect(scrubPII('hello@silvermirror.com is the way')).toContain('[redacted-email]');
  });

  it('redacts credit card numbers in common formats (per /codex review P1)', () => {
    // 16-digit Visa/MC/Discover, various separators
    expect(scrubPII('Card 4111 1111 1111 1111 was declined')).toContain('[redacted-card]');
    expect(scrubPII('Card 4111-1111-1111-1111 declined')).toContain('[redacted-card]');
    expect(scrubPII('Card 4111111111111111 declined')).toContain('[redacted-card]');
    // 15-digit Amex
    expect(scrubPII('Amex 3782 822463 10005 declined')).toContain('[redacted-card]');
    // The original digits must NOT survive in any form
    expect(scrubPII('Card 4111 1111 1111 1111 declined')).not.toMatch(/4111.{0,4}1111/);
  });

  it('redacts CVV/CVC when in context', () => {
    expect(scrubPII('cvv 123')).toContain('[redacted-cvv]');
    expect(scrubPII('CVC: 4567')).toContain('[redacted-cvv]');
    expect(scrubPII('security code is 999')).toContain('[redacted-cvv]');
    expect(scrubPII('verification code 042')).toContain('[redacted-cvv]');
  });

  it('leaves benign 3-4 digit runs alone (years, suite numbers)', () => {
    // CVV scrubber must require context; bare 3-4 digit runs are not scrubbed.
    expect(scrubPII('I joined in 2024')).toBe('I joined in 2024');
    expect(scrubPII('Suite 405')).toBe('Suite 405');
  });

  it('leaves benign text intact', () => {
    const input = 'My card keeps getting rejected, please help.';
    expect(scrubPII(input)).toBe(input);
  });

  it('handles non-string inputs without throwing', () => {
    expect(scrubPII(null)).toBe('');
    expect(scrubPII(undefined)).toBe('');
    expect(scrubPII(123)).toBe('');
  });
});

// ----------------------------------------------------------------------------
// recordBookingError — rate-limit + PII + payload shape
// (acceptance criteria #6, #7, #9.2, #9.3, #9.4)
// ----------------------------------------------------------------------------

describe('recordBookingError', () => {
  let captured;
  let redisStub;
  let redisKeys;

  beforeEach(() => {
    captured = [];
    __setCaptureMessageForTests((msg, opts) => {
      captured.push({ msg, opts });
    });
    // Fake Redis: each `set(key, ..., { nx, ex })` succeeds the first time
    // and returns null on collision. Mirrors Upstash semantics.
    redisKeys = new Map();
    redisStub = {
      set: vi.fn(async (key, value, opts) => {
        if (opts && opts.nx) {
          if (redisKeys.has(key)) return null;
          redisKeys.set(key, value);
          return 'OK';
        }
        redisKeys.set(key, value);
        return 'OK';
      }),
    };
    __setRedisForTests(redisStub);
  });

  afterEach(() => {
    __setRedisForTests(null);
    __setCaptureMessageForTests(null);
  });

  it('fires a Sentry event with the spec-defined payload shape', async () => {
    const result = await recordBookingError({
      sessionId: 'sess-abc-123',
      userMessage: 'My card keeps getting rejected',
      botResponse: 'Sorry, please call (888) 677-0055',
      location: 'Flatiron',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    expect(result.fired).toBe(true);
    expect(captured).toHaveLength(1);
    const { msg, opts } = captured[0];
    expect(msg).toBe('chatbot.booking_error_detected');
    expect(opts.level).toBe('warning');
    expect(opts.tags).toEqual({
      category: 'booking_error',
      subcategory: 'card_payment',
    });
    expect(opts.extra.session_id).toBe('sess-abc-123');
    expect(opts.extra.user_message).toBe('My card keeps getting rejected');
    expect(opts.extra.location).toBe('Flatiron');
    expect(typeof opts.extra.timestamp).toBe('string');
    // bot_response is included only when provided; here it is, scrubbed.
    expect(opts.extra.bot_response).not.toContain('888');
    expect(opts.extra.bot_response).toContain('[redacted-phone]');
  });

  it('omits bot_response from extras when not provided (post /codex P1 #2 fix)', async () => {
    // The chat route now fires on detection (before bot has responded), so
    // botResponse is intentionally not passed. The event must still fire and
    // the extras object must NOT carry a bot_response key (omitted, not "").
    const result = await recordBookingError({
      sessionId: 'sess-no-botresp-1',
      userMessage: 'card declined',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    expect(result.fired).toBe(true);
    const { extra } = captured[0].opts;
    expect(extra).not.toHaveProperty('bot_response');
    expect(extra.session_id).toBe('sess-no-botresp-1');
    expect(extra.user_message).toBe('card declined');
  });

  it('scrubs credit card PAN and CVV from user_message before sending to Sentry (per /codex review P1 #1)', async () => {
    await recordBookingError({
      sessionId: 'sess-pci-1',
      userMessage: 'Card declined: 4111 1111 1111 1111 cvv 123',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    const { extra } = captured[0].opts;
    expect(extra.user_message).not.toMatch(/4111/);
    expect(extra.user_message).not.toMatch(/1111 1111/);
    expect(extra.user_message).toContain('[redacted-card]');
    expect(extra.user_message).toContain('[redacted-cvv]');
  });

  it('rate-limits: second call with same session+subcategory does NOT fire', async () => {
    const args = {
      sessionId: 'sess-rate-1',
      userMessage: 'card declined',
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    };
    const first = await recordBookingError(args);
    const second = await recordBookingError(args);
    expect(first.fired).toBe(true);
    expect(second.fired).toBe(false);
    expect(second.reason).toBe('rate-limited');
    expect(captured).toHaveLength(1);
  });

  it('different subcategory in the same session DOES fire (independent rate limit per subcategory)', async () => {
    const a = await recordBookingError({
      sessionId: 'sess-multi-1',
      userMessage: 'card declined',
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    const b = await recordBookingError({
      sessionId: 'sess-multi-1',
      userMessage: "promo code invalid",
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.PROMO_CODE,
    });
    expect(a.fired).toBe(true);
    expect(b.fired).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0].opts.tags.subcategory).toBe('card_payment');
    expect(captured[1].opts.tags.subcategory).toBe('promo_code');
  });

  it('redacts PII (phones, emails) from user_message and bot_response', async () => {
    await recordBookingError({
      sessionId: 'sess-pii-1',
      userMessage: 'I am Jane Doe, jane@example.com, 212-555-1234, my card was rejected',
      botResponse: 'Please email hello@silvermirror.com or call 888-512-7546',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    const { extra } = captured[0].opts;
    expect(extra.user_message).not.toMatch(/212.?555.?1234/);
    expect(extra.user_message).not.toMatch(/jane@example\.com/);
    expect(extra.user_message).toContain('[redacted-phone]');
    expect(extra.user_message).toContain('[redacted-email]');
    expect(extra.bot_response).not.toContain('hello@silvermirror.com');
    expect(extra.bot_response).not.toMatch(/888.?512.?7546/);
    expect(extra.bot_response).toContain('[redacted-email]');
    expect(extra.bot_response).toContain('[redacted-phone]');
  });

  it('does NOT include name fields in the event payload (extras has no first_name / last_name / member_name)', async () => {
    await recordBookingError({
      sessionId: 'sess-name-1',
      userMessage: 'card declined',
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    const { extra } = captured[0].opts;
    expect(extra).not.toHaveProperty('first_name');
    expect(extra).not.toHaveProperty('last_name');
    expect(extra).not.toHaveProperty('name');
    expect(extra).not.toHaveProperty('member_name');
    expect(extra).not.toHaveProperty('email');
    expect(extra).not.toHaveProperty('phone');
  });

  it('rejects invalid subcategory without firing', async () => {
    const result = await recordBookingError({
      sessionId: 'sess-x',
      userMessage: 'whatever',
      botResponse: 'whatever',
      subcategory: 'made_up_category',
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('invalid-subcategory');
    expect(captured).toHaveLength(0);
  });

  it('rejects missing sessionId without firing', async () => {
    const result = await recordBookingError({
      sessionId: '',
      userMessage: 'card declined',
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('no-session-id');
    expect(captured).toHaveLength(0);
  });

  it('fail-opens when Redis is not configured (returns true without throwing)', async () => {
    __setRedisForTests(null);
    const result = await recordBookingError({
      sessionId: 'sess-no-redis',
      userMessage: 'card declined',
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    // When UPSTASH_REDIS_REST_URL is unset in the env (e.g., local dev), the
    // event still fires — a missing dedup window is better than silently
    // dropping a production-bug signal.
    expect(result.fired).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('fail-opens when Redis throws', async () => {
    redisStub.set = vi.fn(async () => {
      throw new Error('Redis is angry');
    });
    const result = await recordBookingError({
      sessionId: 'sess-redis-err',
      userMessage: 'card declined',
      botResponse: 'please call',
      subcategory: SUBCATEGORIES.CARD_PAYMENT,
    });
    expect(result.fired).toBe(true);
    expect(captured).toHaveLength(1);
  });
});
