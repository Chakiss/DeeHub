import { randomBytes } from 'node:crypto';

/**
 * Ambiguous characters removed on purpose: no i/l/1, no o/0.
 *
 * This gets read off a screen and typed once by someone who did not choose it,
 * often over the phone. A denser alphabet would carry more entropy per
 * character and be transcribed wrongly, which ends with the password written on
 * a sticky note instead.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const GROUPS = 4;
const GROUP_LENGTH = 5;

/**
 * A one-time password for an account someone else is setting up.
 *
 * 20 characters from a 31-symbol alphabet is about 99 bits — far beyond what a
 * scrypt hash needs, and it only has to survive until the recipient changes it.
 *
 * Uses rejection sampling rather than a plain modulo: 256 is not a multiple of
 * 31, so `byte % 31` would make the first nine letters ~13% likelier than the
 * rest. Not a practical break at this length, but a biased generator is the
 * kind of thing that gets copied somewhere it does matter.
 */
export function generateTemporaryPassword(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const chars: string[] = [];

  while (chars.length < GROUPS * GROUP_LENGTH) {
    for (const byte of randomBytes(GROUPS * GROUP_LENGTH)) {
      if (byte >= limit) continue;
      chars.push(ALPHABET[byte % ALPHABET.length]!);
      if (chars.length === GROUPS * GROUP_LENGTH) break;
    }
  }

  return Array.from({ length: GROUPS }, (_, group) =>
    chars.slice(group * GROUP_LENGTH, (group + 1) * GROUP_LENGTH).join(''),
  ).join('-');
}
