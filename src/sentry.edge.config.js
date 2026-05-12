// Sentry - Edge runtime init. Loaded by src/instrumentation.js. This app runs
// almost everything on the Node.js runtime, but Next middleware/edge routes (if
// any) use this. Inert until SENTRY_DSN is set.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
});
