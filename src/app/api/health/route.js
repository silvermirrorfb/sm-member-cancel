import { NextResponse } from 'next/server';
import { getAnthropicModel, verifyAnthropicModel } from '../../../lib/claude';
import { probeRedis } from '../../../lib/health-probes';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — Health check endpoint for external monitoring (QA system, uptime checkers).
 * Returns env var status without exposing actual values.
 *
 * Add ?deep=1 to also live-validate dependencies: the configured Anthropic model
 * (a bad ANTHROPIC_MODEL would otherwise 404 at runtime on /api/chat/message) and
 * a real Redis set/get/del round-trip (Redis runs sessions, rate limits, the
 * registry, and the legal STOP list). The default check stays fast (no API calls)
 * so routine uptime pings are cheap; the daily sms-health-check cron can hit
 * ?deep=1. A failed deep probe degrades the endpoint to 503.
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
  const isDeep = deep === '1' || deep === 'true';
  let anthropicModelCheck = null;
  if (isDeep && checks.anthropic) {
    anthropicModelCheck = await verifyAnthropicModel();
  }

  // Deep probes (live dependency round-trips). Each returns { ok, configured, error? }.
  const probes = {};
  if (isDeep) {
    probes.redis = await probeRedis();
  }

  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const modelBad = anthropicModelCheck ? anthropicModelCheck.ok === false : false;
  const probeBad = Object.values(probes).some(p => p && p.ok === false);
  const status = (missing.length === 0 && !modelBad && !probeBad) ? 'healthy' : 'degraded';

  return NextResponse.json({
    status,
    ok: status === 'healthy',
    timestamp: new Date().toISOString(),
    services: checks,
    anthropicModel: getAnthropicModel(),
    ...(anthropicModelCheck ? { anthropicModelCheck } : {}),
    ...(Object.keys(probes).length > 0 ? { probes } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  }, { status: status === 'healthy' ? 200 : 503 });
}
