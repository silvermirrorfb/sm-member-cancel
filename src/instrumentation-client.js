// Sentry - browser/client init for the chat widget. Inert unless
// NEXT_PUBLIC_SENTRY_DSN is set (kept separate from the server DSN so we don't
// ship the server DSN to the browser bundle by accident).
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || 'development',
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  // Suppress a non-fatal iOS Safari / WKWebView unhandled rejection ("WeakMap keys
  // must be objects ...") that began reporting when the browser DSN went live
  // ~2026-06-16. Diagnosed as a dependency + WKWebView feature gap, not a widget
  // break: the mechanism is onunhandledrejection (not a render/hydration crash),
  // and the widget serves + starts chat sessions fine (verified live). This regex
  // hides only that one message; any real new error still reports. Deferred
  // follow-ups: Sentry source-map upload and pinning the exact dependency frame.
  ignoreErrors: [/WeakMap keys must be objects/],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
