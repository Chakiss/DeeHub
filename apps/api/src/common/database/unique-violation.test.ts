import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './unique-violation';

/** Shaped like what pg throws, wrapped the way Drizzle wraps it. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('driver error'), { code, constraint });
}

function wrapped(depth: number, inner: Error): Error {
  let error = inner;
  for (let i = 0; i < depth; i += 1) {
    error = Object.assign(new Error('wrapped'), { cause: error });
  }
  return error;
}

describe('isUniqueViolation', () => {
  it('matches a bare driver error', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
  });

  // The reason this helper exists: Drizzle puts the pg error on `cause`, so a
  // top-level check never matches and a duplicate code surfaces as a 500.
  it('finds the driver error through the cause chain', () => {
    expect(isUniqueViolation(wrapped(3, pgError('23505')))).toBe(true);
  });

  it('matches a named constraint', () => {
    expect(
      isUniqueViolation(
        wrapped(1, pgError('23505', 'room_types_property_code_uq')),
        'room_types_property_code_uq',
      ),
    ).toBe(true);
  });

  // Otherwise a collision on an unrelated index is reported as a duplicate
  // code, and the user changes the one field that was already correct.
  it('does not match a different constraint', () => {
    expect(
      isUniqueViolation(
        wrapped(1, pgError('23505', 'rate_plans_property_code_uq')),
        'room_types_property_code_uq',
      ),
    ).toBe(false);
  });

  it('does not match another error code', () => {
    expect(isUniqueViolation(wrapped(2, pgError('23503')))).toBe(false);
  });

  it('stops rather than following an unbounded chain', () => {
    expect(isUniqueViolation(wrapped(20, pgError('23505')))).toBe(false);
  });

  it('handles values that are not errors at all', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });
});
