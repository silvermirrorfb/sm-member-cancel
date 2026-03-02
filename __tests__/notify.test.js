import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('P2-2: SMTP missing does not log PII', () => {
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

  it('does not log transcript or member email to console', async () => {
    const { sendSummaryEmail } = await import('../src/lib/notify.js');

    const summary = {
      client_name: 'Sophia Dowd',
      email: 'sophia@secret.com',
      phone: '470-428-5700',
      outcome: 'CANCELLED',
      member_sentiment: 'neutral',
      reason_primary: 'Price',
    };
    const transcript = '[MEMBER]: I want to cancel my membership\n[BOT]: I understand...';

    const result = await sendSummaryEmail(summary, transcript);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('SMTP not configured');

    // Ensure no PII was logged
    const allLogCalls = consoleLogSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(allLogCalls).not.toContain('sophia@secret.com');
    expect(allLogCalls).not.toContain('I want to cancel');
    expect(allLogCalls).not.toContain('470-428-5700');
  });
});
