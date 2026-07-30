/**
 * Report an unhandled error so Google Cloud Error Reporting groups it.
 *
 * Why this exists alongside Sentry: Sentry needs an account and a DSN, and
 * until somebody creates one the product runs in production with NO error
 * reporting at all — a 500 in front of a guest booking a room is invisible.
 * Error Reporting is already part of the project, costs nothing, and needs no
 * signup, so it is the floor rather than the ceiling. Sentry stays wired and
 * takes over the moment SENTRY_DSN is set; both can run at once.
 *
 * The shape matters. Cloud Run parses a single line of JSON on stdout into a
 * structured log entry, and Error Reporting only groups an entry when the
 * message carries a real stack trace. The Nest logger's pretty multi-line
 * output gets split into one entry per line, so the stack arrives as a dozen
 * unrelated records that group into nothing.
 */
const REPORTED_ERROR_EVENT =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

export interface ErrorContext {
  readonly requestId?: string | null;
  readonly method?: string;
  readonly url?: string;
  readonly userId?: string | null;
}

/** Outside Google Cloud there is no Error Reporting to report to. */
function runningOnCloudRun(): boolean {
  return Boolean(process.env['K_SERVICE']);
}

export function reportError(error: unknown, context: ErrorContext = {}): void {
  // In development the Nest logger's readable output is more useful than a
  // line of JSON, and it has already printed the stack.
  if (!runningOnCloudRun()) return;

  const stack =
    error instanceof Error && error.stack
      ? error.stack
      : // Error Reporting requires something stack-shaped; without a frame it
        // silently drops the entry rather than grouping it badly.
        `Error: ${String(error)}\n    at unknown (unknown:0:0)`;

  const entry = {
    '@type': REPORTED_ERROR_EVENT,
    severity: 'ERROR',
    message: stack,
    context: {
      httpRequest: {
        method: context.method ?? '',
        url: context.url ?? '',
        // Always 500 here: handled domain errors never reach this path.
        responseStatusCode: 500,
      },
      // Groups a burst of failures by who hit them, without storing anything
      // about the person beyond an id already in every audit row.
      user: context.userId ?? '',
    },
    // The thread back to the full request in the ordinary logs.
    requestId: context.requestId ?? null,
    serviceContext: {
      service: process.env['K_SERVICE'] ?? 'deehub-api',
      version: process.env['GIT_SHA'] ?? 'unknown',
    },
  };

  // One line, written directly: a logger that wraps or prettifies this breaks
  // the parsing that makes it work.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
