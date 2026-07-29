import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  holdsInventory,
  isTerminal,
  RESERVATION_STATUSES,
  type ReservationStatus,
} from './reservation-status';
import { generateReservationCode, isReservationCode } from './reservation-code';

describe('holdsInventory()', () => {
  it('holds for active and completed stays', () => {
    expect(holdsInventory('PENDING')).toBe(true);
    expect(holdsInventory('CONFIRMED')).toBe(true);
    expect(holdsInventory('CHECKED_IN')).toBe(true);
    // The guest occupied those nights; releasing them would make historical
    // occupancy reports understate reality.
    expect(holdsInventory('CHECKED_OUT')).toBe(true);
  });

  it('does not hold for cancelled, no-show or expired', () => {
    expect(holdsInventory('CANCELLED')).toBe(false);
    expect(holdsInventory('NO_SHOW')).toBe(false);
    expect(holdsInventory('EXPIRED')).toBe(false);
  });
});

describe('canTransition()', () => {
  it('walks the happy path', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransition('CHECKED_IN', 'CHECKED_OUT')).toBe(true);
  });

  it('allows cancellation up to check-out', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransition('CONFIRMED', 'CANCELLED')).toBe(true);
    expect(canTransition('CHECKED_IN', 'CANCELLED')).toBe(true);
  });

  it('refuses to resurrect a finished reservation', () => {
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false);
    expect(canTransition('CHECKED_OUT', 'CHECKED_IN')).toBe(false);
    expect(canTransition('NO_SHOW', 'CHECKED_IN')).toBe(false);
    expect(canTransition('EXPIRED', 'CONFIRMED')).toBe(false);
  });

  it('refuses to skip check-in', () => {
    expect(canTransition('CONFIRMED', 'CHECKED_OUT')).toBe(false);
    expect(canTransition('PENDING', 'CHECKED_IN')).toBe(false);
  });

  it('refuses a no-show for a guest who already arrived', () => {
    expect(canTransition('CHECKED_IN', 'NO_SHOW')).toBe(false);
  });

  it('only expires holds', () => {
    expect(canTransition('PENDING', 'EXPIRED')).toBe(true);
    expect(canTransition('CONFIRMED', 'EXPIRED')).toBe(false);
  });

  it('never allows a transition to itself', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('assertTransition()', () => {
  it('passes silently for a legal move', () => {
    expect(() => assertTransition('CONFIRMED', 'CHECKED_IN')).not.toThrow();
  });

  it('throws the typed domain error for an illegal move', () => {
    try {
      assertTransition('CANCELLED', 'CHECKED_IN');
      expect.unreachable('should have thrown');
    } catch (error) {
      const domain = error as Error & { code: string; details: Record<string, unknown> };
      expect(domain.code).toBe('INVALID_STATE_TRANSITION');
      expect(domain.details).toEqual({ from: 'CANCELLED', to: 'CHECKED_IN' });
    }
  });
});

describe('isTerminal()', () => {
  it('identifies end states', () => {
    const terminal: ReservationStatus[] = ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW', 'EXPIRED'];
    for (const status of terminal) expect(isTerminal(status)).toBe(true);
    for (const status of ['PENDING', 'CONFIRMED', 'CHECKED_IN'] as ReservationStatus[]) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});

describe('generateReservationCode()', () => {
  it('produces a recognisable, validatable code', () => {
    const code = generateReservationCode();
    expect(code).toMatch(/^DH-[A-Z0-9]{6}$/);
    expect(isReservationCode(code)).toBe(true);
  });

  it('omits characters that are ambiguous when read aloud', () => {
    // 1,000 samples: enough that any allowed ambiguous glyph would show up.
    const codes = Array.from({ length: 1000 }, () => generateReservationCode());
    for (const forbidden of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(codes.some((code) => code.slice(3).includes(forbidden))).toBe(false);
    }
  });

  it('is not sequential — codes must not be enumerable', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateReservationCode()));
    // 30^6 ≈ 729M combinations, so 500 draws should essentially never collide.
    expect(codes.size).toBe(500);
  });

  it('rejects malformed codes', () => {
    expect(isReservationCode('DH-ABC')).toBe(false);
    expect(isReservationCode('XX-ABCDEF')).toBe(false);
    expect(isReservationCode('DH-ABCDE0')).toBe(false);
  });
});
