import { describe, expect, it } from 'vitest';
import {
  bindPhoneToSession,
  getReplyForMessageSid,
  getSessionIdForPhone,
  normalizePhone,
  storeReplyForMessageSid,
} from '../src/lib/sms-sessions.js';

describe('sms session mapping', () => {
  it('normalizes and maps phone to session id', () => {
    const phone = '(555) 555-1234';
    const normalized = normalizePhone(phone);
    expect(normalized).toBe('+15555551234');

    bindPhoneToSession(phone, 'sess-1');
    expect(getSessionIdForPhone('+1 555 555 1234')).toBe('sess-1');
  });

  it('stores and returns message sid replay twiml', () => {
    storeReplyForMessageSid('SM123', '<Response><Message>ok</Message></Response>');
    expect(getReplyForMessageSid('SM123')).toContain('<Message>ok</Message>');
  });
});
