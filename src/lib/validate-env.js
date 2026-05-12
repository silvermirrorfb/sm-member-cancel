/**
 * Environment-variable validation.
 *
 * Two jobs:
 *  1. validateEnv() runs once at server boot (from src/instrumentation.js) and
 *     prints a loud "[env]" block: a console.error if a hard-required var is
 *     missing, and one console.warn per subsystem that is partly/fully
 *     unconfigured. This is the observability that was missing when a misconfig
 *     would silently degrade a workload (QA_ISSUES cross-cutting #4).
 *  2. assertSubsystem(name) gives integration code a cheap, explicit check it
 *     can use to fail loudly / fail closed instead of silently no-op'ing:
 *       const env = assertSubsystem('email');
 *       if (!env.ok) return { sent: false, reason: env.message };
 *
 * Adding a var: put it in HARD_REQUIRED (the app cannot function without it) or
 * in the relevant SUBSYSTEMS entry (the named workload is disabled without it).
 */

// Without these the app cannot function at all.
const HARD_REQUIRED = ['ANTHROPIC_API_KEY'];

// Named workloads and the env vars each one needs. Missing vars => that workload
// is degraded/disabled, but the rest of the app keeps running.
const SUBSYSTEMS = {
  boulevard: {
    label: 'Boulevard (member lookup, appointment scans)',
    vars: ['BOULEVARD_API_URL', 'BOULEVARD_API_KEY', 'BOULEVARD_API_SECRET', 'BOULEVARD_BUSINESS_ID'],
  },
  email: {
    label: 'Email notifications (cancellation summaries, ops alerts)',
    vars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_TO'],
  },
  sheets: {
    label: 'Google Sheets logging (cancellations + chat log)',
    vars: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID', 'GOOGLE_CHATLOG_SHEET_ID'],
  },
  redis: {
    label: 'Upstash Redis (sessions, registry, cooldowns, rate limiting, send counter)',
    vars: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  },
  twilio: {
    label: 'Twilio (outbound SMS send + inbound webhook)',
    vars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  },
  klaviyo: {
    label: 'Klaviyo (the TCPA SMS-consent gate)',
    vars: ['KLAVIYO_PRIVATE_API_KEY'],
  },
  sms_cron: {
    label: 'Outbound SMS cron (sms-upgrade-scan / sms-health-check)',
    vars: ['CRON_SECRET', 'SMS_CRON_ENABLED', 'SMS_CRON_LOCATIONS', 'SMS_AUTOMATION_TOKEN'],
  },
};

// Nice-to-have, not tied to a workload that breaks without it.
const OPTIONAL = ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'EMAIL_ESCALATION', 'EMAIL_REACTION_ALERTS'];

function isSet(key) {
  return String(process.env[key] || '').trim() !== '';
}

/**
 * Check one named subsystem's env vars.
 * @param {string} name - a key of SUBSYSTEMS
 * @returns {{ ok: boolean, missing: string[], message: string }}
 */
export function assertSubsystem(name) {
  const spec = SUBSYSTEMS[name];
  if (!spec) return { ok: false, missing: [], message: `unknown subsystem: ${name}` };
  const missing = spec.vars.filter(v => !isSet(v));
  return {
    ok: missing.length === 0,
    missing,
    message: missing.length === 0
      ? `${spec.label}: configured`
      : `${spec.label}: NOT configured (missing ${missing.join(', ')})`,
  };
}

/**
 * Run at boot. Logs a loud summary; never throws (a missing var should not
 * crash the whole app, but it must be impossible to miss in the logs).
 * @returns {{ hardMissing: string[], subsystems: Record<string,{ok:boolean,missing:string[]}>, optionalMissing: string[] }}
 */
export function validateEnv() {
  const hardMissing = HARD_REQUIRED.filter(v => !isSet(v));
  const subsystems = {};
  for (const name of Object.keys(SUBSYSTEMS)) {
    const { ok, missing } = assertSubsystem(name);
    subsystems[name] = { ok, missing };
  }
  const optionalMissing = OPTIONAL.filter(v => !isSet(v));

  if (hardMissing.length > 0) {
    console.error(`[env] MISSING HARD-REQUIRED env var(s): ${hardMissing.join(', ')} - the app will not work correctly until these are set.`);
  }

  const degraded = Object.entries(subsystems).filter(([, s]) => !s.ok);
  if (degraded.length > 0) {
    console.warn('[env] Subsystem env warnings (these workloads are degraded/disabled):');
    for (const [name, s] of degraded) {
      console.warn(`  - ${SUBSYSTEMS[name].label}: missing ${s.missing.join(', ')}`);
    }
  } else {
    console.log('[env] All subsystem env vars present.');
  }

  if (optionalMissing.length > 0) {
    console.log(`[env] Optional env vars not set: ${optionalMissing.join(', ')}`);
  }

  return { hardMissing, subsystems, optionalMissing };
}
