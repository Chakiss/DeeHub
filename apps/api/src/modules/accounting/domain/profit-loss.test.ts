import { describe, expect, it } from 'vitest';
import {
  computeProfitLoss,
  expenseCostMinor,
  type ExpenseLine,
  type RevenueLine,
} from './profit-loss';
import type { ExpenseGroup } from './expense-category';

const THB = 'THB';

function revenue(partial: Partial<RevenueLine> & Pick<RevenueLine, 'source'>): RevenueLine {
  return { netMinor: 0, serviceChargeMinor: 0, vatMinor: 0, ...partial };
}

function expense(
  partial: Partial<ExpenseLine> & { group: ExpenseGroup; categoryCode: string },
): ExpenseLine {
  return {
    categoryId: partial.categoryCode,
    categoryNameTh: partial.categoryCode,
    categoryNameEn: partial.categoryCode,
    netMinor: 0,
    vatMinor: 0,
    vatClaimable: true,
    isDeductible: true,
    ...partial,
  };
}

/** A month: 100,000 room + 10,000 service charge + 7,700 VAT collected. */
const ROOM_MONTH = revenue({
  source: 'ROOM',
  netMinor: 10_000_000,
  serviceChargeMinor: 1_000_000,
  vatMinor: 770_000,
});

describe('computeProfitLoss()', () => {
  /** The rule that, broken, overstates profit by 7% every month. */
  it('excludes output VAT from revenue', () => {
    const result = computeProfitLoss([ROOM_MONTH], [], THB);
    expect(result.totalRevenue.amount).toBe(11_000_000);
    expect(result.outputVat.amount).toBe(770_000);
    // The VAT is reported, and it is not in the revenue figure.
    expect(result.totalRevenue.amount).not.toBe(11_770_000);
  });

  /** The mirror-image mistake: netting the service charge off instead of counting it. */
  it('counts the service charge as revenue', () => {
    const result = computeProfitLoss([ROOM_MONTH], [], THB);
    expect(result.serviceCharge.amount).toBe(1_000_000);
    expect(result.roomRevenue.amount).toBe(10_000_000);
    expect(result.totalRevenue.amount).toBe(
      result.roomRevenue.amount + result.serviceCharge.amount,
    );
  });

  it('separates rooms, extras and other income', () => {
    const result = computeProfitLoss(
      [
        ROOM_MONTH,
        revenue({ source: 'EXTRAS', netMinor: 500_000, vatMinor: 35_000 }),
        revenue({ source: 'OTHER', netMinor: 200_000 }),
      ],
      [],
      THB,
    );
    expect(result.roomRevenue.amount).toBe(10_000_000);
    expect(result.extrasRevenue.amount).toBe(500_000);
    expect(result.otherRevenue.amount).toBe(200_000);
    expect(result.totalRevenue.amount).toBe(11_700_000);
    expect(result.outputVat.amount).toBe(805_000);
  });

  it('subtracts deductible expenses to reach net profit', () => {
    const result = computeProfitLoss(
      [ROOM_MONTH],
      [
        expense({ group: 'UTILITIES', categoryCode: 'ELECTRICITY', netMinor: 1_500_000 }),
        expense({ group: 'PAYROLL', categoryCode: 'SALARY', netMinor: 4_000_000 }),
      ],
      THB,
    );
    expect(result.totalExpenses.amount).toBe(5_500_000);
    expect(result.netProfit.amount).toBe(5_500_000);
  });

  it('reports a loss as a negative number rather than clamping it', () => {
    const result = computeProfitLoss(
      [revenue({ source: 'ROOM', netMinor: 100_000 })],
      [expense({ group: 'PAYROLL', categoryCode: 'SALARY', netMinor: 500_000 })],
      THB,
    );
    expect(result.netProfit.amount).toBe(-400_000);
  });
});

describe('input VAT', () => {
  it('is excluded from cost when it can be reclaimed', () => {
    const line = expense({
      group: 'UTILITIES',
      categoryCode: 'ELECTRICITY',
      netMinor: 100_000,
      vatMinor: 7_000,
      vatClaimable: true,
    });
    expect(expenseCostMinor(line)).toBe(100_000);
  });

  /**
   * The asymmetry that matters. Irrecoverable input tax is money spent, so it
   * is a cost — and it must also stay out of the ภ.พ.30 claim. Getting this
   * wrong overstates profit and over-claims tax at the same time.
   */
  it('becomes part of the cost when it cannot be reclaimed', () => {
    const line = expense({
      group: 'ADMIN',
      categoryCode: 'MISC',
      netMinor: 100_000,
      vatMinor: 7_000,
      vatClaimable: false,
    });
    expect(expenseCostMinor(line)).toBe(107_000);
  });

  it('claims only the reclaimable half and costs the rest', () => {
    const result = computeProfitLoss(
      [ROOM_MONTH],
      [
        expense({
          group: 'UTILITIES',
          categoryCode: 'ELECTRICITY',
          netMinor: 100_000,
          vatMinor: 7_000,
          vatClaimable: true,
        }),
        expense({
          group: 'OTHER',
          categoryCode: 'MISC',
          netMinor: 100_000,
          vatMinor: 7_000,
          vatClaimable: false,
        }),
      ],
      THB,
    );
    expect(result.reclaimableInputVat.amount).toBe(7_000);
    expect(result.totalExpenses.amount).toBe(207_000);
    expect(result.netVatPayable.amount).toBe(770_000 - 7_000);
  });

  it('reports a VAT credit as a negative payable rather than zero', () => {
    const result = computeProfitLoss(
      [revenue({ source: 'ROOM', netMinor: 100_000, vatMinor: 7_000 })],
      [
        expense({
          group: 'OPERATIONS',
          categoryCode: 'MAINTENANCE',
          netMinor: 1_000_000,
          vatMinor: 70_000,
        }),
      ],
      THB,
    );
    // A month with a big repair and few guests: the hotel is owed, not owing.
    expect(result.netVatPayable.amount).toBe(-63_000);
  });
});

describe('non-deductible spending', () => {
  it('is kept out of net profit but still reported', () => {
    const result = computeProfitLoss(
      [ROOM_MONTH],
      [
        expense({ group: 'UTILITIES', categoryCode: 'ELECTRICITY', netMinor: 1_000_000 }),
        expense({
          group: 'OTHER',
          categoryCode: 'OWNER_DRAW',
          netMinor: 3_000_000,
          isDeductible: false,
        }),
      ],
      THB,
    );
    expect(result.totalExpenses.amount).toBe(1_000_000);
    expect(result.nonDeductibleExpenses.amount).toBe(3_000_000);
    expect(result.netProfit.amount).toBe(10_000_000);
    // What the business actually kept after the owner took their cut.
    expect(result.retained.amount).toBe(7_000_000);
  });

  it('does not put a non-deductible category into an expense group', () => {
    const result = computeProfitLoss(
      [],
      [
        expense({
          group: 'OTHER',
          categoryCode: 'OWNER_DRAW',
          netMinor: 100_000,
          isDeductible: false,
        }),
      ],
      THB,
    );
    expect(result.expenseGroups).toHaveLength(0);
  });
});

describe('grouping', () => {
  it('sums several rows in the same category into one line', () => {
    const result = computeProfitLoss(
      [],
      [
        expense({ group: 'UTILITIES', categoryCode: 'ELECTRICITY', netMinor: 100_000 }),
        expense({ group: 'UTILITIES', categoryCode: 'ELECTRICITY', netMinor: 250_000 }),
      ],
      THB,
    );
    expect(result.expenseGroups[0]?.categories).toHaveLength(1);
    expect(result.expenseGroups[0]?.categories[0]?.amount.amount).toBe(350_000);
  });

  it('orders categories largest first, because that is the question being asked', () => {
    const result = computeProfitLoss(
      [],
      [
        expense({ group: 'UTILITIES', categoryCode: 'WATER', netMinor: 100_000 }),
        expense({ group: 'UTILITIES', categoryCode: 'ELECTRICITY', netMinor: 900_000 }),
        expense({ group: 'UTILITIES', categoryCode: 'INTERNET', netMinor: 300_000 }),
      ],
      THB,
    );
    expect(result.expenseGroups[0]?.categories.map((c) => c.categoryCode)).toEqual([
      'ELECTRICITY',
      'INTERNET',
      'WATER',
    ]);
  });

  it('keeps groups in report order and drops the empty ones', () => {
    const result = computeProfitLoss(
      [],
      [
        expense({ group: 'FINANCE', categoryCode: 'BANK_FEE', netMinor: 5_000 }),
        expense({ group: 'COGS', categoryCode: 'LINEN', netMinor: 50_000 }),
        expense({ group: 'PAYROLL', categoryCode: 'SALARY', netMinor: 500_000 }),
      ],
      THB,
    );
    expect(result.expenseGroups.map((g) => g.group)).toEqual(['COGS', 'PAYROLL', 'FINANCE']);
  });

  it('group totals add up to the reported total', () => {
    const result = computeProfitLoss(
      [],
      [
        expense({ group: 'UTILITIES', categoryCode: 'ELECTRICITY', netMinor: 123_457 }),
        expense({ group: 'PAYROLL', categoryCode: 'SALARY', netMinor: 765_431 }),
        expense({ group: 'COGS', categoryCode: 'LINEN', netMinor: 1 }),
      ],
      THB,
    );
    const summed = result.expenseGroups.reduce((total, group) => total + group.amount.amount, 0);
    expect(summed).toBe(result.totalExpenses.amount);
  });
});

describe('an empty month', () => {
  it('reports zeroes rather than failing', () => {
    const result = computeProfitLoss([], [], THB);
    expect(result.totalRevenue.amount).toBe(0);
    expect(result.totalExpenses.amount).toBe(0);
    expect(result.netProfit.amount).toBe(0);
    expect(result.netVatPayable.amount).toBe(0);
    expect(result.expenseGroups).toHaveLength(0);
    expect(result.currency).toBe(THB);
  });
});
