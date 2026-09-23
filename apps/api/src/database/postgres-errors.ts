/**
 * Recognising a Postgres constraint refusal through Drizzle's wrapping.
 *
 * Some invariants are enforced by the database because the application cannot
 * make check-then-write atomic without locking (the room-overlap EXCLUDE is the
 * example). When one of those fires, the caller has to turn it into a message a
 * front desk can act on instead of a 500 — which means recognising it first.
 */

/** `exclusion_violation`. */
const EXCLUSION_VIOLATION = '23P01';

/** `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps driver errors, so the pg error sits down the `cause` chain.
 * The depth limit is a guard against a cyclic chain, not a real expectation.
 */
function matches(error: unknown, code: string, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return (
        candidate.code === code &&
        typeof candidate.constraint === 'string' &&
        candidate.constraint.includes(constraint)
      );
    }
    current = candidate.cause;
  }
  return false;
}

export function isExclusionViolation(error: unknown, constraint: string): boolean {
  return matches(error, EXCLUSION_VIOLATION, constraint);
}

/**
 * A partial unique index refusing a duplicate.
 *
 * Postgres reports the index name in `constraint` for a unique index just as it
 * does for a named constraint, so the two are recognised the same way. Used
 * where a pre-check would race — two people entering the same supplier invoice
 * at the same moment both pass a SELECT and both write.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return matches(error, UNIQUE_VIOLATION, constraint);
}

/** Two stays may not hold the same physical room on overlapping nights. */
export const ROOM_OVERLAP_CONSTRAINT = 'reservation_stays_room_no_overlap';
