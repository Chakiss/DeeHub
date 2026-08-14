/**
 * Thai taxpayer identification numbers (เลขประจำตัวผู้เสียภาษีอากร).
 *
 * Thirteen digits with a mod-11 weighted check digit — the same scheme as the
 * national ID card, which is why an individual's tax ID *is* their ID number.
 *
 * This is validation, not encryption. A tax ID is printed on every invoice the
 * business issues and on every one it receives; it identifies a taxpayer, it
 * does not authenticate one. Storing it enciphered would protect nothing and
 * would stop the one thing that actually helps — checking it — from happening
 * in SQL. What is worth catching is a typo, because a wrong ID on a purchase
 * invoice is input tax the Revenue Department can disallow, and nobody notices
 * until the assessment arrives.
 */

const DIGITS_ONLY = /^[0-9]{13}$/;

/** A branch is five digits; '00000' is สำนักงานใหญ่, the head office. */
const BRANCH_CODE = /^[0-9]{5}$/;

export const HEAD_OFFICE_BRANCH_CODE = '00000';

/**
 * Whether the check digit agrees with the other twelve.
 *
 * The first twelve digits are weighted 13 down to 2, summed, and the remainder
 * modulo 11 gives the thirteenth as `(11 - remainder) % 10`.
 *
 * **It is a filter, not a proof.** Measured over the sweep in the test file,
 * the scheme rejects about 91% of single wrong digits and 96% of adjacent
 * transpositions — good, and not the 100% a mod-11 scheme would give if it did
 * not have to fit its result into one decimal digit. Remainders 0 and 10 both
 * fold to a check digit of 1, so errors that move the sum between those two
 * remainders pass. Nothing can be done about that; it is the national scheme.
 *
 * The consequence for callers: a valid-looking ID is not a verified taxpayer.
 * Use this to catch typing mistakes at the point of entry, never as evidence
 * that a supplier is who their invoice says they are.
 */
export function isValidThaiTaxId(value: string): boolean {
  if (!DIGITS_ONLY.test(value)) return false;

  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(value[index]) * (13 - index);
  }
  const expected = (11 - (sum % 11)) % 10;
  return expected === Number(value[12]);
}

export function isValidBranchCode(value: string): boolean {
  return BRANCH_CODE.test(value);
}

/**
 * Strip the punctuation people type.
 *
 * A tax ID is printed as `0-1055-56012-34-1` and copied out of documents with
 * spaces and hyphens intact. Rejecting that as invalid teaches the owner that
 * the field is fussy; accepting it costs one line.
 */
export function normalizeThaiTaxId(value: string): string {
  return value.replace(/[\s-]/g, '');
}

/** For display: `0-1055-56012-34-1`, the grouping printed on Thai documents. */
export function formatThaiTaxId(value: string): string {
  if (!DIGITS_ONLY.test(value)) return value;
  return `${value.slice(0, 1)}-${value.slice(1, 5)}-${value.slice(5, 10)}-${value.slice(
    10,
    12,
  )}-${value.slice(12)}`;
}
