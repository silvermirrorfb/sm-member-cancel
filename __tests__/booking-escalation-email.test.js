import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMail = vi.fn(async () => ({}));
const createTransport = vi.fn(() => ({ sendMail }));

vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

// Covers sendBookingEscalationEmail: the hello@ routing added so a booking/checkout
// failure reaches the team WITH the error text the bot captured from the guest.
// The detection-time incident email (sendSupportIncidentEmail -> EMAIL_QA_ALERT) is a
// separate channel and is deliberately left alone; see notify.test.js.
describe('sendBookingEscalationEmail (booking issue routing to hello@)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_PORT = '587';
    process.env.EMAIL_FROM = 'info@test';
    process.env.GOOGLE_CHATLOG_SHEET_ID = 'SHEET123';
    delete process.env.EMAIL_BOOKING_ESCALATION;
    delete process.env.EMAIL_QA_ALERT;
    delete process.env.EMAIL_ESCALATION;
    sendMail.mockClear();
    createTransport.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function details(overrides = {}) {
    return {
      date: '2026-07-16T12:00:00.000Z',
      session_id: 'sess_abc',
      session_created: '2026-07-16T11:58:00.000Z',
      error_text: 'Card declined, code CVC_MISMATCH',
      step: 'payment',
      ...overrides,
    };
  }

  it('defaults to hello@silvermirror.com', async () => {
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    const result = await sendBookingEscalationEmail(details());

    expect(result).toEqual({ sent: true });
    expect(sendMail.mock.calls[0][0].to).toBe('hello@silvermirror.com');
  });

  it('honors EMAIL_BOOKING_ESCALATION when set', async () => {
    process.env.EMAIL_BOOKING_ESCALATION = 'bookings@example.com';
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details());

    expect(sendMail.mock.calls[0][0].to).toBe('bookings@example.com');
  });

  it('does not borrow the cancel-bot escalation or QA channels', async () => {
    process.env.EMAIL_ESCALATION = 'guest-escalation@example.com';
    process.env.EMAIL_QA_ALERT = 'qatesting@example.com';
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details());

    const to = sendMail.mock.calls[0][0].to;
    expect(to).toBe('hello@silvermirror.com');
    expect(to).not.toContain('guest-escalation@example.com');
    expect(to).not.toContain('qatesting@example.com');
  });

  it('carries the captured error text, the failing step, and the session id', async () => {
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details());

    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toContain('sess_abc');
    expect(mail.text).toContain('Session ID: sess_abc');
    expect(mail.text).toContain('Session started: 2026-07-16T11:58:00.000Z');
    expect(mail.text).toContain('Card declined, code CVC_MISMATCH');
    expect(mail.text).toContain('During payment / checkout');
    expect(mail.text).toContain('https://docs.google.com/spreadsheets/d/SHEET123');
  });

  it('labels the selecting step distinctly from the payment step', async () => {
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details({ step: 'selecting', error_text: 'No times load' }));

    expect(sendMail.mock.calls[0][0].text).toContain('While selecting an appointment');
  });

  it('falls back to the unclear label for an unknown step', async () => {
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details({ step: 'nonsense' }));

    expect(sendMail.mock.calls[0][0].text).toContain('Not clear from the conversation');
  });

  it('promises no timeline or outcome on the guest\'s behalf', async () => {
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details());

    const body = sendMail.mock.calls[0][0].text;
    expect(body).not.toMatch(/within \d+ hours/i);
    expect(body).not.toMatch(/SLA Shared With Guest/i);
    expect(body).toContain('(888) 677-0055');
  });

  it('contains no em or en dashes', async () => {
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    await sendBookingEscalationEmail(details());

    const mail = sendMail.mock.calls[0][0];
    expect(mail.text).not.toMatch(/[–—]/);
    expect(mail.subject).not.toMatch(/[–—]/);
  });

  it('does not send and does not leak guest text when SMTP is unconfigured', async () => {
    delete process.env.SMTP_HOST;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    const result = await sendBookingEscalationEmail(details());

    expect(result.sent).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).not.toContain('CVC_MISMATCH');
    warn.mockRestore();
  });

  it('reports a send failure instead of throwing', async () => {
    sendMail.mockRejectedValueOnce(new Error('smtp exploded'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    const { sendBookingEscalationEmail } = await import('../src/lib/notify.js');

    const result = await sendBookingEscalationEmail(details());

    expect(result).toEqual({ sent: false, reason: 'smtp exploded' });
    error.mockRestore();
  });
});
