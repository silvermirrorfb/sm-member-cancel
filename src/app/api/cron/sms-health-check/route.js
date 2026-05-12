export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getDailySendCount, localDateStr } from '../../../../lib/sms-metrics';
import { sendOpsAlertEmail } from '../../../../lib/notify';

function isCronAuthorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const authHeader = String(request.headers.get('authorization') || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim() === secret;
  }
  const fallbackHeader = String(request.headers.get('x-cron-secret') || '').trim();
  return fallbackHeader === secret;
}

function parseEnabledFlag() {
  const raw = String(process.env.SMS_CRON_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// Daily watchdog: if yesterday's outbound-SMS send count fell below the
// threshold, email ops. This is the alerting that was missing when the
// April 2026 outage ran undetected for ~3 weeks (QA_ISSUES cross-cutting #1).
export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized cron request.' }, { status: 401 });
  }
  if (!parseEnabledFlag()) {
    return NextResponse.json({ ok: true, skipped: 'SMS_CRON_ENABLED is false' });
  }

  const threshold = Math.max(0, Number(process.env.SMS_MIN_DAILY_SENDS || 1));
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = localDateStr(yesterday);
  const sends = await getDailySendCount(dateStr);

  if (sends < threshold) {
    const subject = `[Silver Mirror] LOW outbound SMS on ${dateStr}: ${sends} send(s) (threshold ${threshold})`;
    const text = [
      `The pre-appointment SMS pipeline recorded ${sends} send(s) on ${dateStr}, below the alert threshold of ${threshold}.`,
      '',
      'If this is the first day after a deploy, the counter may simply have no history yet — confirm before treating it as an outage.',
      '',
      'Checklist:',
      '1. Vercel cron logs for "[sms-upgrade-scan]" lines — look at summary.sent and summary.skippedByReason.',
      '2. SMS_CRON_ENABLED / SMS_REQUIRE_MANUAL_LIVE_APPROVAL / SMS_UPGRADE_STATUS env values.',
      '3. Redis registry counts (HLEN sms-registry:loc:* — should be ~6,000 across 10 locations) — re-run /api/cron/sms-registry-seed if empty.',
      '4. Boulevard auth / scanAppointments errors.',
      '',
      'See docs/outbound-sms-system-and-issues.md and QA_ISSUES.md (outbound-sms section).',
    ].join('\n');
    const result = await sendOpsAlertEmail({ subject, text });
    console.warn('[sms-health-check]', JSON.stringify({ alerted: true, emailSent: result?.sent === true, yesterdaySends: sends, threshold, date: dateStr }));
    return NextResponse.json({ ok: true, alerted: true, emailSent: result?.sent === true, yesterdaySends: sends, threshold, date: dateStr });
  }

  console.log('[sms-health-check]', JSON.stringify({ alerted: false, yesterdaySends: sends, threshold, date: dateStr }));
  return NextResponse.json({ ok: true, alerted: false, yesterdaySends: sends, threshold, date: dateStr });
}
