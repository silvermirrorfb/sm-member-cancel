import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDailySendCount = vi.fn();
const sendOpsAlertEmail = vi.fn(async () => ({ sent: true }));

vi.mock('../src/lib/sms-metrics.js', () => ({
  getDailySendCount,
  localDateStr: () => '2026-05-11',
}));

vi.mock('../src/lib/notify.js', () => ({
  sendOpsAlertEmail,
}));

async function loadRoute() {
  vi.resetModules();
  return import('../src/app/api/cron/sms-health-check/route.js');
}

describe('GET /api/cron/sms-health-check', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = '';
    process.env.SMS_CRON_ENABLED = 'true';
    delete process.env.SMS_MIN_DAILY_SENDS;
    getDailySendCount.mockReset();
    sendOpsAlertEmail.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('alerts (and emails) when yesterday had fewer sends than the threshold', async () => {
    getDailySendCount.mockResolvedValue(0);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, alerted: true, yesterdaySends: 0, threshold: 1, date: '2026-05-11' });
    expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendOpsAlertEmail.mock.calls[0][0].subject).toMatch(/outbound SMS on 2026-05-11/i);
    expect(getDailySendCount).toHaveBeenCalledWith('2026-05-11');
  });

  it('does not alert when yesterday met the threshold', async () => {
    getDailySendCount.mockResolvedValue(12);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, alerted: false, yesterdaySends: 12 });
    expect(sendOpsAlertEmail).not.toHaveBeenCalled();
  });

  it('respects a custom SMS_MIN_DAILY_SENDS threshold', async () => {
    process.env.SMS_MIN_DAILY_SENDS = '5';
    getDailySendCount.mockResolvedValue(3);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
    const body = await res.json();
    expect(body).toMatchObject({ alerted: true, yesterdaySends: 3, threshold: 5 });
    expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('skips when SMS_CRON_ENABLED is falsy', async () => {
    process.env.SMS_CRON_ENABLED = 'false';
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
    const body = await res.json();
    expect(body).toEqual({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });
    expect(getDailySendCount).not.toHaveBeenCalled();
    expect(sendOpsAlertEmail).not.toHaveBeenCalled();
  });

  it('401s when CRON_SECRET is set but the request is unauthorized', async () => {
    process.env.CRON_SECRET = 'super-secret';
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-health-check'));
    expect(res.status).toBe(401);
    expect(sendOpsAlertEmail).not.toHaveBeenCalled();
  });

  it('passes with the correct Bearer CRON_SECRET', async () => {
    process.env.CRON_SECRET = 'super-secret';
    getDailySendCount.mockResolvedValue(8);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://app.test/api/cron/sms-health-check', {
      headers: { authorization: 'Bearer super-secret' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, alerted: false, yesterdaySends: 8 });
  });
});
