import { v7 as uuidv7 } from 'uuid';

/**
 * UUID v7 — time-ordered, so index locality is close to a bigserial without
 * leaking row counts or being guessable (docs/database.md §1).
 *
 * Generated in the application rather than the database so an aggregate knows
 * its own identity before it is persisted, which the domain layer needs in
 * order to build events that reference it.
 */
export function newId(): string {
  return uuidv7();
}
