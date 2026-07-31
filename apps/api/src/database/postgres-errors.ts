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

/**
 * Drizzle wraps driver errors, so the pg error sits down the `cause` chain.
 * The depth limit is a guard against a cyclic chain, not a real expectation.
 */
export function isExclusionViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return (
        candidate.code === EXCLUSION_VIOLATION &&
        typeof candidate.constraint === 'string' &&
        candidate.constraint.includes(constraint)
      );
    }
    current = candidate.cause;
  }
  return false;
}

/** Two stays may not hold the same physical room on overlapping nights. */
export const ROOM_OVERLAP_CONSTRAINT = 'reservation_stays_room_no_overlap';
