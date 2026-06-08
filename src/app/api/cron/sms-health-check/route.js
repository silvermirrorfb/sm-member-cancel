export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getDailySendCount, getDailyCandidateCount, localDateStr } from '../../../../lib/sms-metrics';
import { sendOpsAlertEmail, buildDailyZeroSendAlert } from '../../../../lib/notify';

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
  const candidates = await getDailyCandidateCount(dateStr);

  if (sends < threshold) {
    const { subject, text } = buildDailyZeroSendAlert({ dateStr, sends, candidates, threshold });
    const result = await sendOpsAlertEmail({ subject, text });
    console.warn('[sms-health-check]', JSON.stringify({ alerted: true, emailSent: result?.sent === true, yesterdaySends: sends, candidates, threshold, date: dateStr }));
    return NextResponse.json({ ok: true, alerted: true, emailSent: result?.sent === true, yesterdaySends: sends, candidates, threshold, date: dateStr });
  }

  console.log('[sms-health-check]', JSON.stringify({ alerted: false, yesterdaySends: sends, candidates, threshold, date: dateStr }));
  return NextResponse.json({ ok: true, alerted: false, yesterdaySends: sends, candidates, threshold, date: dateStr });
}
