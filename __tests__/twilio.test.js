import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import {
  buildTwimlMessage,
  isValidTwilioSignature,
  parseTwilioFormBody,
  sanitizeSmsText,
  trimSmsBody,
} from '../src/lib/twilio.js';

describe('twilio helpers', () => {
  it('parses form payloads', () => {
    const parsed = parseTwilioFormBody('From=%2B15555551234&Body=Hello%20there');
    expect(parsed.From).toBe('+15555551234');
    expect(parsed.Body).toBe('Hello there');
  });

  it('builds escaped twiml message', () => {
    const xml = buildTwimlMessage('A < B & "quoted"');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('trims long sms content', () => {
    const long = 'x'.repeat(2000);
    const trimmed = trimSmsBody(long);
    expect(trimmed.length).toBeLessThanOrEqual(150);
  });

  it('rewrites verbose greeting to single-text concise copy', () => {
    const verbose = "Hi! I'm Silver Mirror's virtual assistant. How can I help you today? Whether you have questions about our facials, memberships, booking, or skincare advice?";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe("Hi! I'm Silver Mirror's text assistant. Ask me about facials, booking, memberships, or skincare.");
    expect(compact.length).toBeLessThanOrEqual(150);
  });

  it('rewrites long hello greeting from chat flow', () => {
    const verbose = "Hello! I'm Silver Mirror's virtual assistant. I'm here to help with questions about our facials, services, memberships, products, and skincare. What can I help you with today?";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe("Hi! I'm Silver Mirror's text assistant. Ask me about facials, booking, memberships, or skincare.");
    expect(compact.length).toBeLessThanOrEqual(150);
  });

  it('rewrites chatty greeting replies into short sms copy', () => {
    const verbose = "Hi there! I'm doing well, thank you. I'm Silver Mirror's virtual assistant and I'm here to help with any questions about our facials, services";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe("Hi! I'm Silver Mirror's text assistant. Ask me about facials, booking, memberships, or skincare.");
  });

  it('sanitizes emoji and non-ascii punctuation for sms-safe output', () => {
    const sanitized = sanitizeSmsText('Hi — yes 😊 “quoted”');
    expect(sanitized).toBe('Hi - yes "quoted"');
  });

  it('strips markdown emphasis from sms output', () => {
    const compact = trimSmsBody("Great question! I'd recommend the **Just for Men Facial** for ingrown hairs.");
    expect(compact).not.toContain('**');
    expect(compact).toContain('Just for Men Facial');
  });

  it('preserves booking link as a complete known URL', () => {
    const verbose = "I'd be happy to help you find the perfect facial! You can book online at https://booking.silvermirror.com/booking/location/manhattan-west-2026-05-26-7-30-pm-concert/17913877";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe('Book online at https://booking.silvermirror.com/booking/location');
    expect(compact.endsWith('/booking/location')).toBe(true);
  });

  it('rewrites closest-location answers into a short prompt plus stable link', () => {
    const verbose = "I'd be happy to help you find the closest location! We have 10 locations across three cities:**New York City (5 locations):**- Upper East Side";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe("Tell me your neighborhood or ZIP code and I'll suggest the closest location. All locations: https://silvermirror.com/locations/");
  });

  it('rewrites the live closest-location variant into a short prompt plus stable link', () => {
    const verbose = "I'd be happy to help you find the closest Silver Mirror location! To give you the best recommendation, could you let me know what city or area you're in? We have locations in: - **New York City** (5 locations): Upper East Side";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe("Tell me your neighborhood or ZIP code and I'll suggest the closest location. All locations: https://silvermirror.com/locations/");
  });

  it('rewrites location hours answers into a short stable response', () => {
    const verbose = 'Each Silver Mirror location has different hours. Direct guests to https://silvermirror.com/locations/ for specific hours.';
    const compact = trimSmsBody(verbose);
    expect(compact).toBe('Hours vary by location. See https://silvermirror.com/locations/ or text me the location name.');
  });

  it('rewrites any just-for-men recommendation into sms-safe copy without markdown', () => {
    const verbose = "Great question! For a 41-year-old man, I'd recommend the **Just for Men Facial** because it helps with ingrown hairs and shaving irritation.";
    const compact = trimSmsBody(verbose);
    expect(compact).toBe('For ingrown hairs or shaving irritation, try the Just for Men Facial. Want booking, pricing, or locations?');
  });

  it('validates and rejects twilio signatures', () => {
    const url = 'https://example.com/api/sms/twilio/webhook';
    const params = { From: '+15555551234', Body: 'Hi' };
    const authToken = 'token-123';

    const data = `${url}BodyHiFrom+15555551234`;
    const signature = crypto.createHmac('sha1', authToken).update(data).digest('base64');
    expect(isValidTwilioSignature({
      url,
      params,
      authToken,
      providedSignature: signature,
    })).toBe(true);

    expect(isValidTwilioSignature({
      url,
      params,
      authToken,
      providedSignature: 'bad',
    })).toBe(false);
  });

  it('fails closed when the auth token is missing', () => {
    expect(isValidTwilioSignature({
      url: 'https://example.com/api/sms/twilio/webhook',
      params: { From: '+15555551234', Body: 'Hi' },
      authToken: '',
      providedSignature: 'anything',
    })).toBe(false);
  });
});
