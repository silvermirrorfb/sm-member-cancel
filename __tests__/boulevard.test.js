import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizePhone,
  verifyMemberIdentity,
  levenshtein,
  WALKIN_PRICES,
  CURRENT_RATES,
  PERKS,
} from '../src/lib/boulevard.js';

describe('normalizePhone', () => {
  it('strips non-digits and adds US country code', () => {
    expect(normalizePhone('(470) 428-5700')).toBe('14704285700');
  });

  it('keeps 11-digit numbers as-is', () => {
    expect(normalizePhone('14704285700')).toBe('14704285700');
  });

  it('returns empty string for null/empty', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('sophia dowd', 'sophia dowd')).toBe(0);
  });

  it('returns correct distance for small edits', () => {
    expect(levenshtein('sophia', 'sofhia')).toBeLessThanOrEqual(2);
  });

  it('returns correct distance for different strings', () => {
    expect(levenshtein('sophia', 'matthew')).toBeGreaterThan(3);
  });
});

describe('verifyMemberIdentity (P1-1)', () => {
  const validProfile = {
    name: 'Sophia Dowd',
    email: 'sophia@test.com',
    phone: '(470) 428-5700',
  };

  it('verifies matching name + email', () => {
    const request = { firstName: 'Sophia', lastName: 'Dowd', email: 'sophia@test.com' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(true);
  });

  it('verifies matching name + phone', () => {
    const request = { firstName: 'Sophia', lastName: 'Dowd', phone: '470-428-5700' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(true);
  });

  it('allows fuzzy name match (within levenshtein 3)', () => {
    const request = { firstName: 'Sofia', lastName: 'Dowd', email: 'sophia@test.com' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(true);
  });

  it('rejects name mismatch', () => {
    const request = { firstName: 'John', lastName: 'Smith', email: 'sophia@test.com' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(false);
  });

  it('rejects contact mismatch', () => {
    const request = { firstName: 'Sophia', lastName: 'Dowd', email: 'wrong@test.com', phone: '111-222-3333' };
    expect(verifyMemberIdentity(request, validProfile)).toBe(false);
  });

  it('rejects null inputs', () => {
    expect(verifyMemberIdentity(null, validProfile)).toBe(false);
    expect(verifyMemberIdentity({}, null)).toBe(false);
  });
});

describe('P1-2: Mock fallback gating', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('lookupMember returns null when API key missing in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BOULEVARD_API_KEY;

    // Dynamic import to get fresh module with updated env
    const { lookupMember } = await import('../src/lib/boulevard.js');
    const result = await lookupMember('Test User', 'test@test.com');
    expect(result).toBeNull();
  });
});

describe('constants', () => {
  it('WALKIN_PRICES has expected tiers', () => {
    expect(WALKIN_PRICES['30']).toBe(119);
    expect(WALKIN_PRICES['50']).toBe(169);
    expect(WALKIN_PRICES['90']).toBe(279);
  });

  it('PERKS are sorted by month', () => {
    for (let i = 1; i < PERKS.length; i++) {
      expect(PERKS[i].month).toBeGreaterThan(PERKS[i - 1].month);
    }
  });
});
