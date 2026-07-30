/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Deep enough for Drizzle's wrapping without walking a cycle forever. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether an error is a unique-index violation, optionally for one constraint.
 *
 * Drizzle wraps driver errors, so the pg error carrying `code` and `constraint`
 * sits somewhere down the `cause` chain rather than on the error itself.
 * Checking the top-level object silently never matches, which turns "this code
 * is taken" into a 500.
 *
 * Naming the constraint matters. A bare code check treats every unique index on
 * the table as the same failure, so a collision on some unrelated column gets
 * reported as a duplicate code — and the user changes the one thing that was
 * already fine.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (typeof candidate.code === 'string') {
      if (candidate.code !== UNIQUE_VIOLATION) return false;
      if (!constraint) return true;
      return typeof candidate.constraint === 'string' && candidate.constraint.includes(constraint);
    }

    current = candidate.cause;
  }

  return false;
}
