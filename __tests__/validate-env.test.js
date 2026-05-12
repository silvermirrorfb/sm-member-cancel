import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSubsystem, validateEnv } from '../src/lib/validate-env.js';

describe('validate-env', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('assertSubsystem', () => {
    it('reports ok when every var for the subsystem is set', () => {
      process.env.KLAVIYO_PRIVATE_API_KEY = 'pk_test';
      const r = assertSubsystem('klaviyo');
      expect(r.ok).toBe(true);
      expect(r.missing).toEqual([]);
      expect(r.message).toMatch(/configured/i);
    });

    it('reports the missing vars when some are absent', () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      process.env.TWILIO_FROM_NUMBER = '+18885127546';
      const r = assertSubsystem('twilio');
      expect(r.ok).toBe(false);
      expect(r.missing).toEqual(expect.arrayContaining(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']));
      expect(r.missing).not.toContain('TWILIO_FROM_NUMBER');
      expect(r.message).toMatch(/NOT configured/i);
    });

    it('treats whitespace-only values as unset', () => {
      process.env.KLAVIYO_PRIVATE_API_KEY = '   ';
      const r = assertSubsystem('klaviyo');
      expect(r.ok).toBe(false);
      expect(r.missing).toContain('KLAVIYO_PRIVATE_API_KEY');
    });

    it('returns not-ok for an unknown subsystem name', () => {
      const r = assertSubsystem('does-not-exist');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/unknown subsystem/i);
    });
  });

  describe('validateEnv', () => {
    it('returns a structured summary and never throws', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.KLAVIYO_PRIVATE_API_KEY;
      let result;
      expect(() => { result = validateEnv(); }).not.toThrow();
      expect(result.hardMissing).toContain('ANTHROPIC_API_KEY');
      expect(result.subsystems).toHaveProperty('klaviyo');
      expect(result.subsystems.klaviyo.ok).toBe(false);
      expect(result.subsystems.klaviyo.missing).toContain('KLAVIYO_PRIVATE_API_KEY');
      expect(console.error).toHaveBeenCalled(); // hard-missing var => loud error
    });

    it('logs a clean line when nothing is missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      // Populate one var from every required set so nothing is reported missing.
      process.env.ANTHROPIC_API_KEY = 'x';
      for (const k of [
        'BOULEVARD_API_URL', 'BOULEVARD_API_KEY', 'BOULEVARD_API_SECRET', 'BOULEVARD_BUSINESS_ID',
        'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_TO',
        'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID', 'GOOGLE_CHATLOG_SHEET_ID',
        'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
        'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
        'KLAVIYO_PRIVATE_API_KEY',
        'CRON_SECRET', 'SMS_CRON_ENABLED', 'SMS_CRON_LOCATIONS', 'SMS_AUTOMATION_TOKEN',
      ]) process.env[k] = 'x';
      const result = validateEnv();
      expect(result.hardMissing).toEqual([]);
      expect(Object.values(result.subsystems).every(s => s.ok)).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
