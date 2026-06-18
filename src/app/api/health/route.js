import { NextResponse } from 'next/server';
import { getAnthropicModel, verifyAnthropicModel } from '../../../lib/claude';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — Health check endpoint for external monitoring (QA system, uptime checkers).
 * Returns env var status without exposing actual values.
 *
 * Add ?deep=1 to also live-validate the configured Anthropic model. This makes a
 * bad ANTHROPIC_MODEL (e.g. a deprecated dated id that now 404s) fail here with
 * 503 instead of as a runtime 500 on /api/chat/message. The default check stays
 * fast (no API calls) so routine uptime pings are cheap; the daily
 * sms-health-check cron can hit ?deep=1.
 */
export async function GET(request) {
  const checks = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    boulevard: !!process.env.BOULEVARD_API_KEY && !!process.env.BOULEVARD_API_SECRET && !!process.env.BOULEVARD_BUSINESS_ID,
    boulevardUrl: !!process.env.BOULEVARD_API_URL,
    smtp: !!process.env.SMTP_HOST && !!process.env.SMTP_USER,
    googleSheets: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !!process.env.GOOGLE_SHEET_ID,
    chatlogSheet: !!process.env.GOOGLE_CHATLOG_SHEET_ID,
    twilio: !!process.env.TWILIO_ACCOUNT_SID,
    klaviyo: !!process.env.KLAVIYO_PRIVATE_API_KEY,
  };

  let deep = null;
  try {
    deep = new URL(request.url).searchParams.get('deep');
  } catch {
    deep = null;
  }
  let anthropicModelCheck = null;
  if ((deep === '1' || deep === 'true') && checks.anthropic) {
    anthropicModelCheck = await verifyAnthropicModel();
  }

  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const modelBad = anthropicModelCheck ? anthropicModelCheck.ok === false : false;
  const status = (missing.length === 0 && !modelBad) ? 'healthy' : 'degraded';

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    services: checks,
    anthropicModel: getAnthropicModel(),
    ...(anthropicModelCheck ? { anthropicModelCheck } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  }, { status: status === 'healthy' ? 200 : 503 });
}
