import { describe, expect, it } from 'vitest';
import {
  bindPhoneToSession,
  getUpgradeOfferState,
  getReplyForMessageSid,
  getSessionIdForPhone,
  markUpgradeOfferEvent,
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

  it('stores per-appointment offer state for reminder/upgrade suppression', () => {
    markUpgradeOfferEvent('+1 (917) 555-1234', 'appt-1', 'initial_sent', '2026-03-09T16:00:00Z');
    markUpgradeOfferEvent('+19175551234', 'appt-1', 'reminder_sent', '2026-03-09T17:00:00Z');
    markUpgradeOfferEvent('+19175551234', 'appt-1', 'declined', '2026-03-09T17:05:00Z');

    const state = getUpgradeOfferState('9175551234', 'appt-1');
    expect(state?.initialSentAt).toBe('2026-03-09T16:00:00Z');
    expect(state?.reminderSentAt).toBe('2026-03-09T17:00:00Z');
    expect(state?.declinedAt).toBe('2026-03-09T17:05:00Z');
  });
});
