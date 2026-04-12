import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — Health check endpoint for external monitoring (QA system, uptime checkers).
 * Returns env var status without exposing actual values.
 */
export async function GET() {
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

  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const status = missing.length === 0 ? 'healthy' : 'degraded';

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    services: checks,
    ...(missing.length > 0 ? { missing } : {}),
  }, { status: status === 'healthy' ? 200 : 503 });
}
