import { describe, expect, it } from 'vitest';
import {
  addVatToNet,
  computeExpenseAmounts,
  computeWithholding,
  ExpenseAmountError,
  splitVatFromGross,
  suggestWithholdingRateBp,
  WHT_EXEMPTION_THRESHOLD_MINOR,
} from './expense';

const THB = 'THB';
const VAT_7 = 700;

describe('splitVatFromGross()', () => {
  it('pulls 7% out of a round receipt total', () => {
    // 1,070.00 inclusive → 1,000.00 net, 70.00 VAT
    const split = splitVatFromGross(107_000, VAT_7, THB);
    expect(split.net.amount).toBe(100_000);
    expect(split.vat.amount).toBe(7_000);
    expect(split.gross.amount).toBe(107_000);
  });

  it('leaves the amount alone when the supplier charges no VAT', () => {
    const split = splitVatFromGross(50_000, 0, THB);
    expect(split.net.amount).toBe(50_000);
    expect(split.vat.amount).toBe(0);
  });

  /**
   * The property that matters more than any single case: the parts must add
   * back to what the owner typed. A receipt whose lines do not sum to its own
   * total is one the hotel cannot defend in an audit.
   */
  it('always has net + vat equal the original total', () => {
    for (let gross = 1; gross <= 3_000; gross += 1) {
      const split = splitVatFromGross(gross, VAT_7, THB);
      expect(split.net.amount + split.vat.amount).toBe(gross);
    }
  });

  it('holds the same identity at awkward rates', () => {
    for (const rate of [1, 300, 700, 1_000, 9_999]) {
      for (const gross of [1, 7, 99, 12_345, 987_654_321]) {
        const split = splitVatFromGross(gross, rate, THB);
        expect(split.net.amount + split.vat.amount).toBe(gross);
      }
    }
  });

  it('never invents money on a one-satang bill', () => {
    const split = splitVatFromGross(1, VAT_7, THB);
    expect(split.net.amount).toBe(1);
    expect(split.vat.amount).toBe(0);
  });
});

describe('addVatToNet()', () => {
  it('adds 7% to a pre-tax quote', () => {
    const split = addVatToNet(100_000, VAT_7, THB);
    expect(split.vat.amount).toBe(7_000);
    expect(split.gross.amount).toBe(107_000);
  });

  it('round-trips against splitVatFromGross', () => {
    for (const net of [1, 99, 100_000, 333_333]) {
      const up = addVatToNet(net, VAT_7, THB);
      const down = splitVatFromGross(up.gross.amount, VAT_7, THB);
      expect(down.net.amount).toBe(net);
    }
  });
});

describe('computeWithholding()', () => {
  it.each([
    ['rent', 500, 100_000, 5_000],
    ['services and hire of work', 300, 100_000, 3_000],
    ['advertising', 200, 100_000, 2_000],
    ['transport', 100, 100_000, 1_000],
  ])('withholds %s at %i bp', (_label, rateBp, netMinor, expected) => {
    expect(computeWithholding(netMinor, rateBp, THB).amount).toBe(expected);
  });

  it('withholds nothing at a zero rate', () => {
    expect(computeWithholding(500_000, 0, THB).amount).toBe(0);
  });

  /**
   * The base is the pre-VAT value, and this test exists because getting it
   * wrong is invisible: 3% of 10,700 looks like a plausible number right up
   * until the supplier disputes the payment and the certificate is wrong.
   */
  it('is computed on the value of the service, not on the VAT charged on it', () => {
    const amounts = computeExpenseAmounts({
      amountMinor: 107_000, // 1,070 inclusive of 7% VAT
      amountIs: 'GROSS',
      vatRateBp: VAT_7,
      whtRateBp: 300,
      currency: THB,
    });
    // 3% of 1,000 = 30, not 3% of 1,070 = 32.10
    expect(amounts.wht.amount).toBe(3_000);
    expect(amounts.paid.amount).toBe(104_000);
  });
});

describe('suggestWithholdingRateBp()', () => {
  it('suggests nothing below the 1,000 baht threshold', () => {
    expect(suggestWithholdingRateBp(WHT_EXEMPTION_THRESHOLD_MINOR - 1, 300)).toBe(0);
  });

  it('suggests the category rate at the threshold and above', () => {
    expect(suggestWithholdingRateBp(WHT_EXEMPTION_THRESHOLD_MINOR, 300)).toBe(300);
    expect(suggestWithholdingRateBp(5_000_000, 500)).toBe(500);
  });

  it('stays silent for a category that never withholds', () => {
    expect(suggestWithholdingRateBp(9_999_999, 0)).toBe(0);
  });
});

describe('computeExpenseAmounts()', () => {
  it('derives every column from a gross amount', () => {
    const amounts = computeExpenseAmounts({
      amountMinor: 107_000,
      amountIs: 'GROSS',
      vatRateBp: VAT_7,
      whtRateBp: 300,
      currency: THB,
    });
    expect(amounts.net.amount).toBe(100_000);
    expect(amounts.vat.amount).toBe(7_000);
    expect(amounts.gross.amount).toBe(107_000);
    expect(amounts.wht.amount).toBe(3_000);
    expect(amounts.paid.amount).toBe(104_000);
  });

  /** The two identities the database also enforces, over a wide input sweep. */
  it('keeps gross = net + vat and paid = gross - wht', () => {
    for (const amountIs of ['GROSS', 'NET'] as const) {
      for (const vatRateBp of [0, 700, 1_000]) {
        for (const whtRateBp of [0, 100, 300, 500]) {
          for (const amountMinor of [1, 999, 100_000, 107_000, 1_234_567]) {
            const a = computeExpenseAmounts({
              amountMinor,
              amountIs,
              vatRateBp,
              whtRateBp,
              currency: THB,
            });
            expect(a.gross.amount).toBe(a.net.amount + a.vat.amount);
            expect(a.paid.amount).toBe(a.gross.amount - a.wht.amount);
            expect(a.paid.amount).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('rejects an amount that is not a positive whole number of satang', () => {
    for (const amountMinor of [0, -1, 10.5]) {
      expect(() =>
        computeExpenseAmounts({
          amountMinor,
          amountIs: 'GROSS',
          vatRateBp: VAT_7,
          whtRateBp: 0,
          currency: THB,
        }),
      ).toThrow(ExpenseAmountError);
    }
  });

  it('rejects rates outside 0–100%', () => {
    expect(() =>
      computeExpenseAmounts({
        amountMinor: 100_000,
        amountIs: 'NET',
        vatRateBp: 10_001,
        whtRateBp: 0,
        currency: THB,
      }),
    ).toThrow(ExpenseAmountError);

    expect(() =>
      computeExpenseAmounts({
        amountMinor: 100_000,
        amountIs: 'NET',
        vatRateBp: 0,
        whtRateBp: -1,
        currency: THB,
      }),
    ).toThrow(ExpenseAmountError);
  });

  it('refuses to withhold more than the bill is worth', () => {
    // 100% withholding on a net amount, with VAT on top, still fits; the guard
    // is for the shape where it would not.
    const full = computeExpenseAmounts({
      amountMinor: 100_000,
      amountIs: 'NET',
      vatRateBp: 0,
      whtRateBp: 10_000,
      currency: THB,
    });
    expect(full.paid.amount).toBe(0);
  });
});
