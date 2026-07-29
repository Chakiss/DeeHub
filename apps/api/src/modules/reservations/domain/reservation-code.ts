import { randomInt } from 'node:crypto';

/**
 * Human-facing reservation reference, e.g. `DH-8F3K2A`.
 *
 * Alphabet excludes I, L, O, U, 0 and 1: these codes get read over the phone
 * and written on paper by front-desk staff, so "0 or O?" is a real support
 * cost. Uniqueness is enforced by the database index, not by hoping — the
 * caller retries on conflict.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;
const PREFIX = 'DH-';

export function generateReservationCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // randomInt is CSPRNG-backed: sequential or guessable codes would let
    // anyone enumerate other guests' bookings in a lookup form.
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${PREFIX}${code}`;
}

const CODE_PATTERN = new RegExp(`^${PREFIX}[${ALPHABET}]{${String(CODE_LENGTH)}}$`);

export function isReservationCode(value: string): boolean {
  return CODE_PATTERN.test(value.toUpperCase());
}
