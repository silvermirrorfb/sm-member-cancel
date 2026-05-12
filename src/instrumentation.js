// Next.js instrumentation hook - runs once when the server (or an edge worker)
// boots. We use it to initialize Sentry per-runtime. Inert until SENTRY_DSN set.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Loud env-var check at boot: prints which subsystems are degraded/disabled
    // due to missing config (QA_ISSUES cross-cutting #4). Never throws.
    try {
      const { validateEnv } = await import('./lib/validate-env');
      validateEnv();
    } catch {
      // validation must never break startup
    }
    await import('./sentry.server.config');
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Forward uncaught errors from React Server Components / route handlers to Sentry.
export async function onRequestError(...args) {
  const { captureRequestError } = await import('@sentry/nextjs');
  return captureRequestError(...args);
}
