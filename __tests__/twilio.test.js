import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import {
  buildTwimlMessage,
  isValidTwilioSignature,
  parseTwilioFormBody,
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
    expect(trimmed.length).toBeLessThanOrEqual(1200);
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
});
