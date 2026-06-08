import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMail = vi.fn(async () => ({}));
const createTransport = vi.fn(() => ({ sendMail }));

vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

describe('sendOpsAlertEmail recipient routing (EMAIL_OPS_ALERTS split)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_PORT = '587';
    process.env.EMAIL_FROM = 'info@test';
    delete process.env.EMAIL_OPS_ALERTS;
    delete process.env.EMAIL_ESCALATION;
    delete process.env.EMAIL_TO;
    sendMail.mockClear();
    createTransport.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('routes to EMAIL_OPS_ALERTS when set', async () => {
    process.env.EMAIL_OPS_ALERTS = 'ops@example.com';
    process.env.EMAIL_ESCALATION = 'guest-escalation@example.com';
    process.env.EMAIL_TO = 'memberships@example.com';
    vi.resetModules();
    const { sendOpsAlertEmail } = await import('../src/lib/notify.js');

    const result = await sendOpsAlertEmail({ subject: 'test', text: 'body' });

    expect(result.sent).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('ops@example.com');
  });

  it('falls back to literal matt@silvermirror.com when EMAIL_OPS_ALERTS is unset', async () => {
    // Even with EMAIL_ESCALATION and EMAIL_TO set, ops alerts must NOT borrow those channels.
    process.env.EMAIL_ESCALATION = 'guest-escalation@example.com';
    process.env.EMAIL_TO = 'memberships@example.com';
    vi.resetModules();
    const { sendOpsAlertEmail } = await import('../src/lib/notify.js');

    const result = await sendOpsAlertEmail({ subject: 'test', text: 'body' });

    expect(result.sent).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('matt@silvermirror.com');
  });

  it('does not consult EMAIL_ESCALATION even when EMAIL_OPS_ALERTS is unset', async () => {
    process.env.EMAIL_ESCALATION = 'hello@silvermirror.com';
    vi.resetModules();
    const { sendOpsAlertEmail } = await import('../src/lib/notify.js');

    await sendOpsAlertEmail({ subject: 'test', text: 'body' });

    expect(sendMail.mock.calls[0][0].to).not.toBe('hello@silvermirror.com');
    expect(sendMail.mock.calls[0][0].to).toBe('matt@silvermirror.com');
  });
});

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
    const allWarnCalls = consoleWarnSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(allLogCalls).not.toContain('sophia@secret.com');
    expect(allLogCalls).not.toContain('I want to cancel');
    expect(allLogCalls).not.toContain('470-428-5700');
    expect(allWarnCalls).not.toContain('Sophia Dowd');
    expect(allWarnCalls).not.toContain('sophia@secret.com');
    expect(allWarnCalls).not.toContain('470-428-5700');
    expect(allWarnCalls).not.toContain('I want to cancel');
    expect(allWarnCalls).toContain('SMTP not configured');
  });
});

describe('chatbot incident email identifiers', () => {
  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.GOOGLE_CHATLOG_SHEET_ID = 'SHEET123';
    sendMail.mockClear();
  });

  it('includes session id, session start time, and a chatlog sheet link', async () => {
    vi.resetModules();
    const { sendSupportIncidentEmail } = await import('../src/lib/notify.js');
    await sendSupportIncidentEmail({
      date: '2026-06-08T12:00:00.000Z',
      session_id: 'sess_xyz',
      session_created: '2026-06-08T11:58:00.000Z',
      issue_type: 'booking_payment_issue',
      user_message: 'my payment failed',
    });
    const body = sendMail.mock.calls[0][0].text;
    expect(body).toContain('Session ID: sess_xyz');
    expect(body).toContain('Session started: 2026-06-08T11:58:00.000Z');
    expect(body).toContain('https://docs.google.com/spreadsheets/d/SHEET123');
    expect(body).not.toContain('—');
  });
});
