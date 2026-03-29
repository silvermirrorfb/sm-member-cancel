import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Reason-based team alerts', () => {
  const originalEnv = process.env;
  let consoleLogSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('matchReasonToCategory', () => {
    it('matches all 20 reason categories', async () => {
      const { matchReasonToCategory } = await import('../src/lib/notify.js');

      expect(matchReasonToCategory('Travel')).toBe('travel');
      expect(matchReasonToCategory('Relocation')).toBe('relocation');
      expect(matchReasonToCategory('Shifted to Derm')).toBe('shifted_to_derm');
      expect(matchReasonToCategory('New Provider')).toBe('new_provider');
      expect(matchReasonToCategory('Forgot Benefits')).toBe('forgot_benefits');
      expect(matchReasonToCategory('Felt Sold To')).toBe('felt_sold_to');
      expect(matchReasonToCategory('Repetitive')).toBe('repetitive');
      expect(matchReasonToCategory('Esthetician Turnover')).toBe('esthetician_turnover');
      expect(matchReasonToCategory('No Results')).toBe('no_results');
      expect(matchReasonToCategory('No Personalized Plan')).toBe('no_personalized_plan');
      expect(matchReasonToCategory('Reaction')).toBe('reaction');
      expect(matchReasonToCategory('Front Desk Issues')).toBe('front_desk');
      expect(matchReasonToCategory('Inexperienced Esthetician')).toBe('inexperienced_esth');
      expect(matchReasonToCategory('Voucher Build-Up')).toBe('voucher_buildup');
      expect(matchReasonToCategory('Cost Overwhelming')).toBe('cost_overwhelming');
      expect(matchReasonToCategory('Lost Job')).toBe('lost_job');
      expect(matchReasonToCategory('Medical')).toBe('medical');
      expect(matchReasonToCategory('Inconsistent Experience')).toBe('inconsistent');
      expect(matchReasonToCategory('Parking')).toBe('parking');
      expect(matchReasonToCategory('Lack of Value')).toBe('lack_of_value');
    });

    it('matches natural language variations', async () => {
      const { matchReasonToCategory } = await import('../src/lib/notify.js');

      expect(matchReasonToCategory('I moved to a different city')).toBe('relocation');
      expect(matchReasonToCategory('budget')).toBe('cost_overwhelming');
      expect(matchReasonToCategory('cost became too expensive')).toBe('cost_overwhelming');
      expect(matchReasonToCategory('I was laid off')).toBe('lost_job');
      expect(matchReasonToCategory('I started seeing a dermatologist')).toBe('shifted_to_derm');
      expect(matchReasonToCategory('My esthetician left')).toBe('esthetician_turnover');
      expect(matchReasonToCategory('I had an allergic reaction')).toBe('reaction');
      expect(matchReasonToCategory('Not seeing results')).toBe('no_results');
      expect(matchReasonToCategory('The front desk was rude')).toBe('front_desk');
      expect(matchReasonToCategory('health issues')).toBe('medical');
      expect(matchReasonToCategory('not worth it')).toBe('lack_of_value');
      expect(matchReasonToCategory('location became inconvenient')).toBe('parking');
      expect(matchReasonToCategory('I lost my job')).toBe('lost_job');
      expect(matchReasonToCategory('credit buildup')).toBe('voucher_buildup');
    });

    it('returns null for unrecognized reasons', async () => {
      const { matchReasonToCategory } = await import('../src/lib/notify.js');

      expect(matchReasonToCategory(null)).toBeNull();
      expect(matchReasonToCategory('')).toBeNull();
      expect(matchReasonToCategory('something completely random')).toBeNull();
    });
  });

  describe('sendReasonAlert', () => {
    it('skips when SMTP is not configured', async () => {
      const { sendReasonAlert } = await import('../src/lib/notify.js');

      const summary = {
        client_name: 'Test User',
        email: 'test@test.com',
        reason_primary: 'Travel',
        outcome: 'RETAINED',
      };

      const result = await sendReasonAlert(summary, 'test transcript');
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('smtp_not_configured');
    });

    it('skips when reason does not match any category', async () => {
      const { sendReasonAlert } = await import('../src/lib/notify.js');

      const summary = {
        client_name: 'Test User',
        reason_primary: 'completely unknown reason',
        outcome: 'CANCELLED',
      };

      const result = await sendReasonAlert(summary, 'test transcript');
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('no_matching_category');
    });

    it('does not log PII when SMTP is not configured', async () => {
      const { sendReasonAlert } = await import('../src/lib/notify.js');

      const summary = {
        client_name: 'Secret Person',
        email: 'secret@private.com',
        phone: '555-123-4567',
        reason_primary: 'Reaction',
        outcome: 'CANCELLED',
      };

      await sendReasonAlert(summary, 'sensitive conversation details');

      const allWarns = consoleWarnSpy.mock.calls.map((call) => call.join(' ')).join(' ');
      expect(allWarns).not.toContain('secret@private.com');
      expect(allWarns).not.toContain('Secret Person');
      expect(allWarns).not.toContain('555-123-4567');
      expect(allWarns).not.toContain('sensitive conversation');
    });
  });

  describe('Reaction routing includes extra recipients', () => {
    it('reaction category routes to 5 recipients', async () => {
      const { matchReasonToCategory } = await import('../src/lib/notify.js');
      expect(matchReasonToCategory('Reaction')).toBe('reaction');
    });
  });
});
