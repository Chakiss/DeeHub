import { describe, expect, it } from 'vitest';
import { formatThaiTaxId, isValidBranchCode, isValidThaiTaxId, normalizeThaiTaxId } from './tax-id';

/** Independently computed, so the test does not just re-run the implementation. */
function checkDigitFor(twelve: string): number {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(twelve[index]) * (13 - index);
  }
  return (11 - (sum % 11)) % 10;
}

describe('isValidThaiTaxId()', () => {
  it('accepts a well-formed individual ID', () => {
    // 1101700257339 — check digit 9, verified by hand in the test above.
    expect(checkDigitFor('110170025733')).toBe(9);
    expect(isValidThaiTaxId('1101700257339')).toBe(true);
  });

  it('accepts a well-formed juristic ID', () => {
    expect(checkDigitFor('010555601234')).toBe(1);
    expect(isValidThaiTaxId('0105556012341')).toBe(true);
  });

  it('rejects the same ID with the wrong check digit', () => {
    expect(isValidThaiTaxId('0105556012345')).toBe(false);
    expect(isValidThaiTaxId('1101700257330')).toBe(false);
  });

  /*
   * These two measure the filter rather than asserting it is perfect, because
   * it is not. `(11 - remainder) % 10` folds remainders 0 and 10 onto the same
   * check digit, so a minority of errors survive. The numbers below are the
   * real rates; they are asserted with a floor so a regression in the
   * algorithm shows up, and stated out loud so nobody downstream mistakes a
   * valid-looking ID for a verified one.
   */
  const IDS = Array.from({ length: 400 }, (_, seed) => {
    const twelve = String(100_000_000_000 + seed * 7_919).slice(0, 12);
    return twelve + String(checkDigitFor(twelve));
  });

  it('rejects about 91% of single wrong digits, and never a correct ID', () => {
    let tried = 0;
    let caught = 0;
    for (const base of IDS) {
      expect(isValidThaiTaxId(base)).toBe(true);
      for (let index = 0; index < 13; index += 1) {
        for (let digit = 0; digit <= 9; digit += 1) {
          if (String(digit) === base[index]) continue;
          tried += 1;
          if (!isValidThaiTaxId(base.slice(0, index) + String(digit) + base.slice(index + 1))) {
            caught += 1;
          }
        }
      }
    }
    expect(caught / tried).toBeGreaterThan(0.9);
    // Not 1. Asserting perfection here would be asserting something false.
    expect(caught / tried).toBeLessThan(1);
  });

  it('rejects about 96% of adjacent transpositions', () => {
    let tried = 0;
    let caught = 0;
    for (const base of IDS) {
      for (let index = 0; index < 12; index += 1) {
        if (base[index] === base[index + 1]) continue;
        tried += 1;
        const swapped =
          base.slice(0, index) + base[index + 1] + base[index] + base.slice(index + 2);
        if (!isValidThaiTaxId(swapped)) caught += 1;
      }
    }
    expect(tried).toBeGreaterThan(1_000);
    expect(caught / tried).toBeGreaterThan(0.95);
  });

  it('always catches a wrong check digit', () => {
    const base = '1101700257339';
    for (let digit = 0; digit <= 9; digit += 1) {
      const mutated = base.slice(0, 12) + String(digit);
      expect(isValidThaiTaxId(mutated)).toBe(digit === 9);
    }
  });

  it('rejects anything that is not thirteen digits', () => {
    for (const value of ['', '110170025733', '11017002573390', 'abcdefghijklm', '1-101-700']) {
      expect(isValidThaiTaxId(value)).toBe(false);
    }
  });

  it('agrees with an independently computed check digit across many IDs', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const twelve = String(100_000_000_000 + seed * 7_919).slice(0, 12);
      const id = twelve + String(checkDigitFor(twelve));
      expect(isValidThaiTaxId(id)).toBe(true);
    }
  });
});

describe('normalizeThaiTaxId()', () => {
  it('accepts the punctuation printed on Thai documents', () => {
    expect(normalizeThaiTaxId('0-1055-56012-34-1')).toBe('0105556012341');
    expect(normalizeThaiTaxId(' 1101 7002 5733 9 ')).toBe('1101700257339');
    expect(isValidThaiTaxId(normalizeThaiTaxId('0-1055-56012-34-1'))).toBe(true);
  });
});

describe('formatThaiTaxId()', () => {
  it('groups the digits the way a Thai invoice prints them', () => {
    expect(formatThaiTaxId('0105556012341')).toBe('0-1055-56012-34-1');
  });

  it('leaves anything unrecognisable alone rather than mangling it', () => {
    expect(formatThaiTaxId('not-an-id')).toBe('not-an-id');
  });
});

describe('isValidBranchCode()', () => {
  it('accepts head office and numbered branches', () => {
    expect(isValidBranchCode('00000')).toBe(true);
    expect(isValidBranchCode('00001')).toBe(true);
  });

  it('rejects the wrong length or non-digits', () => {
    for (const value of ['0', '000000', 'HQ', '']) {
      expect(isValidBranchCode(value)).toBe(false);
    }
  });
});
