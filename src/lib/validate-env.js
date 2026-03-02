/**
 * Validate environment variables at startup.
 * Logs warnings for missing recommended vars — does NOT throw.
 */

const REQUIRED = [
  'ANTHROPIC_API_KEY',
];

const REQUIRED_FOR_MEMBER_LOOKUP = [
  'BOULEVARD_API_KEY',
  'BOULEVARD_API_SECRET',
  'BOULEVARD_BUSINESS_ID',
];

const RECOMMENDED = [
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'GOOGLE_SHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
];

export function validateEnv() {
  const missing = [];
  const warnings = [];

  for (const key of REQUIRED) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  for (const key of REQUIRED_FOR_MEMBER_LOOKUP) {
    if (!process.env[key]) {
      warnings.push(`${key} not set \u2014 member lookup will be unavailable`);
    }
  }

  for (const key of RECOMMENDED) {
    if (!process.env[key]) {
      warnings.push(`${key} not set \u2014 some features will be degraded`);
    }
  }

  if (missing.length > 0) {
    console.error('[env] MISSING REQUIRED env vars:', missing.join(', '));
  }

  if (warnings.length > 0) {
    console.warn('[env] Environment warnings:');
    for (const w of warnings) {
      console.warn('  -', w);
    }
  }

  return { missing, warnings };
}
