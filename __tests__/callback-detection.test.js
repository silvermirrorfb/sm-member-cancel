import { describe, expect, it } from 'vitest';
import {
  detectCallbackIntent,
  getCallbackRequestedVia,
} from '../src/lib/callback-detection.js';

describe('detectCallbackIntent', () => {
  describe('positive matches', () => {
    it.each([
      ['CALLBACK'],
      ['callback'],
      ['Callback please'],
      ['call me back'],
      ['Call me back'],
      ['  call   me   back  '],
      ['Please call me back'],
      ['please call me'],
      ['call me please'],
      ['can you call me'],
      ['Can you call me tomorrow'],
      ['yes please call'],
      ['Yes, please call me'],
      ['yes call me'],
      ['I want a callback'],
      ['we want a callback'],
      ['I would like a callback'],
      ['I need a callback'],
      ['call back'],
    ])('returns true for "%s"', (msg) => {
      expect(detectCallbackIntent(msg)).toBe(true);
    });
  });

  describe('negative matches', () => {
    it.each([
      ['I was gonna call back tomorrow'],
      ['was going to call back earlier'],
      ['I tried to call back yesterday'],
      ['I meant to call back'],
      ['can you call the salon'],
      ['can you call the front desk'],
      ['I called their office'],
      ["don't call me"],
      ['do not call me'],
      ['no need to call me'],
      ['not call me back'],
      ['Hi there'],
      ['what are your hours'],
      ['how much is a facial'],
      ['just a quick question'],
      [''],
      ['   '],
    ])('returns false for "%s"', (msg) => {
      expect(detectCallbackIntent(msg)).toBe(false);
    });

    it('returns false for null', () => {
      expect(detectCallbackIntent(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(detectCallbackIntent(undefined)).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(detectCallbackIntent(123)).toBe(false);
      expect(detectCallbackIntent({})).toBe(false);
      expect(detectCallbackIntent([])).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('matches case-insensitively', () => {
      expect(detectCallbackIntent('CALL ME BACK')).toBe(true);
      expect(detectCallbackIntent('Call Me Back')).toBe(true);
      expect(detectCallbackIntent('caLL mE BaCK')).toBe(true);
    });

    it('tolerates extra whitespace between words', () => {
      expect(detectCallbackIntent('call     me  back')).toBe(true);
      expect(detectCallbackIntent('please   call  me')).toBe(true);
    });

    it('matches when callback request is embedded in longer sentence', () => {
      expect(detectCallbackIntent('Hi — please call me when you get a chance')).toBe(true);
      expect(detectCallbackIntent('Thanks! Can you call me back later today?')).toBe(true);
    });
  });
});

describe('getCallbackRequestedVia', () => {
  it('returns CALLBACK_keyword when the literal word appears', () => {
    expect(getCallbackRequestedVia('CALLBACK')).toBe('CALLBACK_keyword');
    expect(getCallbackRequestedVia('callback please')).toBe('CALLBACK_keyword');
    expect(getCallbackRequestedVia('I want a callback')).toBe('CALLBACK_keyword');
  });

  it('returns natural_language for phrase-based requests without the literal keyword', () => {
    expect(getCallbackRequestedVia('call me back')).toBe('natural_language');
    expect(getCallbackRequestedVia('please call me')).toBe('natural_language');
    expect(getCallbackRequestedVia('can you call me')).toBe('natural_language');
  });

  it('defaults to natural_language for empty input', () => {
    expect(getCallbackRequestedVia('')).toBe('natural_language');
    expect(getCallbackRequestedVia(null)).toBe('natural_language');
    expect(getCallbackRequestedVia(undefined)).toBe('natural_language');
  });
});
