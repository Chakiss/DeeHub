import * as Sentry from '@sentry/node';

/**
 * Error reporting (architecture.md §10).
 *
 * MUST be initialised before any other import that might throw, which is why
 * this is imported first in both entry points — Sentry instruments modules as
 * they load, and anything imported earlier is invisible to it.
 *
 * A missing DSN disables reporting silently. That is correct for local
 * development and for tests, where a hard failure would be pure friction.
 */
export function initSentry(component: 'api' | 'worker'): void {
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    release: process.env['GIT_SHA'] ?? undefined,
    // Sampled, not exhaustive: full tracing on every booking would cost more
    // than it tells us at this volume.
    tracesSampleRate: Number(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    initialScope: { tags: { component } },

    beforeSend(event) {
      // Never let credentials or guest data reach a third party. The request
      // body is where a password or a passport number would be.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['cookie'];
          delete event.request.headers['x-mock-signature'];
        }
      }
      return event;
    },
  });
}

export { Sentry };
