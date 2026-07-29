import { describe, expect, it } from 'vitest';
import {
  add,
  applyBasisPoints,
  compare,
  equals,
  format,
  fromMajorUnits,
  isZero,
  money,
  MoneyError,
  multiply,
  subtract,
  sum,
  toMajorUnits,
  zero,
} from './money';

describe('money()', () => {
  it('accepts integer minor units', () => {
    expect(money(250000, 'THB')).toEqual({ amount: 250000, currency: 'THB' });
  });

  it('uppercases the currency code', () => {
    expect(money(100, 'thb').currency).toBe('THB');
  });

  it('rejects decimals, which are almost always a major-unit mistake', () => {
    expect(() => money(2500.5, 'THB')).toThrow(MoneyError);
  });

  it('rejects malformed currency codes', () => {
    expect(() => money(100, 'BAHT')).toThrow(MoneyError);
    expect(() => money(100, '')).toThrow(MoneyError);
  });

  it('rejects amounts beyond safe integer precision', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'THB')).toThrow(MoneyError);
  });

  it('returns a frozen object so Money cannot be mutated in place', () => {
    expect(Object.isFrozen(money(1, 'THB'))).toBe(true);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(add(money(250000, 'THB'), money(75000, 'THB')).amount).toBe(325000);
    expect(subtract(money(250000, 'THB'), money(75000, 'THB')).amount).toBe(175000);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'THB'), money(100, 'USD'))).toThrow(/Currency mismatch/);
  });

  it('sums a stay night by night', () => {
    const nights = [money(250000, 'THB'), money(250000, 'THB'), money(300000, 'THB')];
    expect(sum(nights, 'THB').amount).toBe(800000);
  });

  it('sums an empty list to zero', () => {
    expect(isZero(sum([], 'THB'))).toBe(true);
  });

  it('multiplies by whole units only', () => {
    expect(multiply(money(250000, 'THB'), 3).amount).toBe(750000);
    expect(() => multiply(money(250000, 'THB'), 1.5)).toThrow(MoneyError);
  });

  it('compares and equates', () => {
    expect(compare(money(1, 'THB'), money(2, 'THB'))).toBe(-1);
    expect(compare(money(2, 'THB'), money(2, 'THB'))).toBe(0);
    expect(equals(money(2, 'THB'), money(2, 'USD'))).toBe(false);
  });
});

describe('applyBasisPoints()', () => {
  it('computes Thai VAT exactly', () => {
    // 7% of ฿2,500.00 = ฿175.00
    expect(applyBasisPoints(money(250000, 'THB'), 700).amount).toBe(17500);
  });

  it('computes a 10% service charge', () => {
    expect(applyBasisPoints(money(250000, 'THB'), 1000).amount).toBe(25000);
  });

  it('rounds half away from zero symmetrically', () => {
    // 1 satang rounding: 7% of 7 = 0.49 -> 0; of 8 = 0.56 -> 1
    expect(applyBasisPoints(money(7, 'THB'), 700).amount).toBe(0);
    expect(applyBasisPoints(money(8, 'THB'), 700).amount).toBe(1);
    // A refund of the same magnitude must round to the same magnitude.
    expect(applyBasisPoints(money(-8, 'THB'), 700).amount).toBe(-1);
  });

  it('never introduces floating point drift', () => {
    const nightly = money(33333, 'THB');
    const taxed = applyBasisPoints(nightly, 700);
    expect(Number.isInteger(taxed.amount)).toBe(true);
  });
});

describe('major/minor conversion', () => {
  it('round-trips THB through two decimal places', () => {
    expect(toMajorUnits(money(250000, 'THB'))).toBe(2500);
    expect(fromMajorUnits(2500, 'THB').amount).toBe(250000);
  });

  it('handles zero-decimal currencies', () => {
    expect(fromMajorUnits(5000, 'JPY').amount).toBe(5000);
    expect(toMajorUnits(money(5000, 'JPY'))).toBe(5000);
  });

  it('absorbs float error from user input', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
    expect(fromMajorUnits(0.1 + 0.2, 'THB').amount).toBe(30);
  });
});

describe('format()', () => {
  it('renders THB with two decimals', () => {
    expect(format(money(250000, 'THB'))).toContain('2,500.00');
  });

  it('formats zero', () => {
    expect(format(zero('THB'))).toContain('0.00');
  });
});
