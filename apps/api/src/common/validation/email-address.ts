/**
 * The address a person signs in with, cleaned and checked.
 *
 * Twice in one afternoon an unusable owner account reached production, and the
 * second one is the reason this file exists rather than a regex at each call
 * site.
 *
 * First: the literal placeholder `<อีเมลเจ้าของโรงแรม>` was accepted, producing
 * an account the login form refuses to submit. A shape check fixed that.
 *
 * Then a pasted address arrived as `sansorayos9@gmail.com​` — twenty-two
 * characters that print as twenty-one. A zero-width space is not whitespace to
 * JavaScript (`\s` covers U+2000–U+200A and stops one short of U+200B), so it
 * sailed through the shape check and would have been stored. Nobody could sign
 * in with the address they can see, and nothing on the screen would say why.
 *
 * Copying an address out of a chat window, a PDF or a spreadsheet is the normal
 * way one arrives, and all three carry these characters. So the invisible ones
 * are removed rather than rejected, and what remains must be printable ASCII:
 * anything else in an address someone types at a hotel front desk is a paste
 * artefact, not an address.
 */

/** Zero-width space, ZWNJ, ZWJ, word joiner, BOM, and the bidi controls. */
const INVISIBLE = /[​-‏⁠﻿‪-‮]/g;

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

export class InvalidEmailError extends Error {}

/**
 * Returns the address to store, or throws with a message a human can act on.
 *
 * Lower-cased, because a hotelier who signs up as `Owner@` and later types
 * `owner@` is the same person and should not be locked out over it.
 */
export function normaliseEmailAddress(raw: string, label = 'email'): string {
  const stripped = raw.replace(INVISIBLE, '').trim();
  const hidden = raw.trim().length - stripped.length;
  const email = stripped.toLowerCase();

  if (!SHAPE.test(email)) {
    throw new InvalidEmailError(
      `Invalid ${label} "${raw}". This is the address the hotel signs in with — ` +
        'a placeholder here creates an account that cannot be used.',
    );
  }

  if (!PRINTABLE_ASCII.test(email)) {
    throw new InvalidEmailError(
      `Invalid ${label} "${email}": it contains characters that are not plain text. ` +
        'Retype it rather than pasting it.',
    );
  }

  if (hidden > 0) {
    // Not a failure — the address was recoverable — but the operator should
    // know the thing they pasted was not what they thought they pasted.
    console.warn(
      `  note: removed ${hidden} invisible character(s) from the ${label} before saving`,
    );
  }

  return email;
}
