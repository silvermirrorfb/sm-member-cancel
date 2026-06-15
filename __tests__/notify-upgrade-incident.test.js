import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-D: when a member replies YES to an upgrade but it punts to manual_followup
// or fails read-back verification, a human must be emailed (not just logged to a
// sheet). One email per member+appointment (Redis dedupe), plain English, no
// timeline promises, no em dashes, and a notify failure must never throw.

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: (...a) => sendMail(...a) }) },
}));

const redisSet = vi.fn();
// Must be a regular function, not an arrow: notify.js calls `new Redis(...)`,
// and an arrow function is not constructable.
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(function () { return { set: (...a) => redisSet(...a) }; }),
}));

async function loadNotify() {
  vi.resetModules();
  return import('../src/lib/notify.js');
}

const baseEnv = process.env;

function manualFollowupIncident(over = {}) {
  return {
    date: '2026-06-13T18:00:00.000Z',
    session_id: 'sess-1',
    issue_type: 'sms_upgrade_manual_followup',
    name: 'Dana Roe',
    email: 'dana@example.com',
    phone: '+15550001111',
    location: 'Bryant Park',
    appointment_id: 'urn:blvd:Appointment:appt-1',
    user_message: 'Inbound SMS YES from +15550001111. | reason=upgrade_mutation_disabled | offerKind=duration | appointmentId=urn:blvd:Appointment:appt-1',
    reason: 'upgrade_mutation_disabled',
    ...over,
  };
}

describe('notifyUpgradeIncidentOnce / sendUpgradeIncidentEmail', () => {
  beforeEach(() => {
    process.env = {
      ...baseEnv,
      SMTP_HOST: 'smtp.test',
      SMTP_PORT: '587',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      EMAIL_FROM: 'info@silvermirror.com',
      EMAIL_OPS_ALERTS: 'ops@silvermirror.com',
      GOOGLE_CHATLOG_SHEET_ID: 'CHATLOG123',
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    };
    sendMail.mockReset().mockResolvedValue({ messageId: 'm1' });
    redisSet.mockReset().mockResolvedValue('OK'); // fresh by default
  });

  afterEach(() => {
    process.env = baseEnv;
  });

  it('manual_followup triggers exactly one email to the ops recipients with the member fields', async () => {
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    const res = await notifyUpgradeIncidentOnce(manualFollowupIncident());

    expect(res).toEqual({ sent: true, deduped: false });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('ops@silvermirror.com');
    expect(mail.subject).toContain('Needs attention');
    const body = String(mail.text || '');
    expect(body).toContain('Dana Roe');
    expect(body).toContain('+15550001111');
    expect(body).toContain('Bryant Park');
    expect(body).toContain('urn:blvd:Appointment:appt-1');
    expect(body).toContain('upgrade_mutation_disabled');
    expect(body).toContain('https://docs.google.com/spreadsheets/d/CHATLOG123');
    // No em dashes and no timeline promises.
    expect(body).not.toMatch(/[—–]/);
    expect(body).not.toMatch(/\d+\s*(hour|day|minute|business day)/i);
  });

  it('verification-failed (notes_sync_failed) triggers one email and the body names the read-back check', async () => {
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    const res = await notifyUpgradeIncidentOnce(manualFollowupIncident({ reason: 'notes_sync_failed' }));

    expect(res).toEqual({ sent: true, deduped: false });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const body = String(sendMail.mock.calls[0][0].text || '');
    expect(body).toContain('read-back');
    expect(body).toContain('notes_sync_failed');
    expect(body).not.toMatch(/[—–]/);
  });

  it('a duplicate outcome within the dedupe window sends no second email', async () => {
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    redisSet.mockResolvedValueOnce('OK'); // first: fresh
    redisSet.mockResolvedValueOnce(null);  // second: already set

    const first = await notifyUpgradeIncidentOnce(manualFollowupIncident());
    const second = await notifyUpgradeIncidentOnce(manualFollowupIncident());

    expect(first).toEqual({ sent: true, deduped: false });
    expect(second).toEqual({ sent: false, deduped: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    // Dedupe key is per member+appointment and uses SET NX EX (the ops-alert pattern).
    expect(redisSet).toHaveBeenCalledWith(
      'sms-upgrade-incident:+15550001111:urn:blvd:Appointment:appt-1',
      '1',
      { nx: true, ex: 86400 },
    );
  });

  it('fails open: a Redis dedupe error still sends the email (the incident must not be dropped)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    const { notifyUpgradeIncidentOnce } = await loadNotify();

    const res = await notifyUpgradeIncidentOnce(manualFollowupIncident());

    expect(res).toEqual({ sent: true, deduped: false });
    expect(redisSet).toHaveBeenCalledTimes(1); // the dedupe attempt actually ran and threw
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled(); // dedupe failure is logged
    errorSpy.mockRestore();
  });

  it('does not email for a non-upgrade incident type (no misleading YES email)', async () => {
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    const res = await notifyUpgradeIncidentOnce(manualFollowupIncident({ issue_type: 'some_other_incident' }));

    expect(res).toEqual({ sent: false, skipped: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('is a safe no-op when SMTP is unconfigured (no send, no throw)', async () => {
    delete process.env.SMTP_HOST;
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    const res = await notifyUpgradeIncidentOnce(manualFollowupIncident());

    expect(res).toEqual({ sent: false, deduped: false });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('falls back to session_id in the dedupe key when phone is absent', async () => {
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    await notifyUpgradeIncidentOnce(manualFollowupIncident({ phone: null }));
    expect(redisSet).toHaveBeenCalledWith(
      'sms-upgrade-incident:sess-1:urn:blvd:Appointment:appt-1',
      '1',
      { nx: true, ex: 86400 },
    );
  });

  it('uses the noappt sentinel in the dedupe key when appointment_id is absent', async () => {
    const { notifyUpgradeIncidentOnce } = await loadNotify();
    await notifyUpgradeIncidentOnce(manualFollowupIncident({ appointment_id: null }));
    expect(redisSet).toHaveBeenCalledWith(
      'sms-upgrade-incident:+15550001111:noappt',
      '1',
      { nx: true, ex: 86400 },
    );
  });

  it('a notify failure logs at error level and never throws (so the member reply is never broken)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendMail.mockRejectedValueOnce(new Error('smtp exploded'));
    const { notifyUpgradeIncidentOnce } = await loadNotify();

    const res = await notifyUpgradeIncidentOnce(manualFollowupIncident());

    expect(res).toEqual({ sent: false, deduped: false });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
