import { add, money, subtract, sum, type Money } from '@deehub/shared';
import { EXPENSE_GROUP_ORDER, type ExpenseGroup } from './expense-category';

/**
 * What the hotel made, and what it cost (accounting-plan.md §2).
 *
 * Pure arithmetic over rows someone else has already loaded and filtered. The
 * cash/accrual choice is made by *which rows are passed in* — cash filters on
 * the date money moved, accrual on the date the obligation arose — so there is
 * one aggregation and not two that could drift apart.
 *
 * Two rules live here and nowhere else, because both are easy to get wrong in
 * a way that looks right:
 *
 * **VAT is not revenue.** The 7% collected from a guest was never the hotel's
 * money; it is held for the Revenue Department. Counting it as income
 * overstates profit by 7% every single month, and the resulting figure is
 * plausible enough that nobody questions it until a tax assessment does.
 *
 * **Service charge IS revenue.** The 10% is the hotel's income even when it is
 * paid out to staff — that payout is a wage expense with its own line. Netting
 * it off against revenue would understate both sides at once.
 */

/** One source of income, already separated into its tax components. */
export interface RevenueLine {
  readonly source: 'ROOM' | 'EXTRAS' | 'OTHER';
  /** Before service charge and VAT. */
  readonly netMinor: number;
  readonly serviceChargeMinor: number;
  /** Output VAT. Reported, never counted as income. */
  readonly vatMinor: number;
}

/** One expense row, reduced to what the report needs. */
export interface ExpenseLine {
  readonly group: ExpenseGroup;
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryNameTh: string;
  readonly categoryNameEn: string;
  /** Before VAT. */
  readonly netMinor: number;
  readonly vatMinor: number;
  /** False when the input tax cannot be reclaimed, which makes it a real cost. */
  readonly vatClaimable: boolean;
  readonly isDeductible: boolean;
}

export interface ProfitLossCategoryTotal {
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryNameTh: string;
  readonly categoryNameEn: string;
  readonly amount: Money;
}

export interface ProfitLossGroupTotal {
  readonly group: ExpenseGroup;
  readonly categories: readonly ProfitLossCategoryTotal[];
  readonly amount: Money;
}

export interface ProfitLoss {
  readonly currency: string;
  readonly roomRevenue: Money;
  readonly extrasRevenue: Money;
  readonly otherRevenue: Money;
  /** The hotel's own 10%, across every source. */
  readonly serviceCharge: Money;
  /** Room + extras + other + service charge. Excludes VAT, by definition. */
  readonly totalRevenue: Money;

  readonly expenseGroups: readonly ProfitLossGroupTotal[];
  /** Deductible costs only — what reduces taxable profit. */
  readonly totalExpenses: Money;
  /**
   * Real spending that does not reduce taxable profit: the owner taking money
   * out, a fine. Shown apart rather than hidden, because it leaves the bank
   * account either way and an owner reconciling to a statement needs to see it.
   */
  readonly nonDeductibleExpenses: Money;

  readonly netProfit: Money;
  /** Net profit less the money taken out. What the business actually kept. */
  readonly retained: Money;

  /** Not a profit-and-loss line. A liability, reported alongside for the month. */
  readonly outputVat: Money;
  readonly reclaimableInputVat: Money;
  /** Positive means owed to the Revenue Department; negative is a credit carried forward. */
  readonly netVatPayable: Money;
}

/**
 * The cost an expense row actually imposes.
 *
 * Net of VAT — **unless the VAT cannot be reclaimed**, in which case it is
 * money gone and belongs in the cost. Entertainment, a supplier's invoice that
 * does not meet มาตรา 86/4, a purchase made before the hotel was registered:
 * the tax on all of these is spent, not recoverable, and treating it as
 * reclaimable would both overstate profit and inflate the input tax claimed on
 * ภ.พ.30 — two errors from one omission, in opposite directions.
 */
export function expenseCostMinor(line: ExpenseLine): number {
  return line.vatClaimable ? line.netMinor : line.netMinor + line.vatMinor;
}

export function computeProfitLoss(
  revenue: readonly RevenueLine[],
  expenses: readonly ExpenseLine[],
  currency: string,
): ProfitLoss {
  const bySource = (source: RevenueLine['source']): Money =>
    sum(
      revenue
        .filter((line) => line.source === source)
        .map((line) => money(line.netMinor, currency)),
      currency,
    );

  const roomRevenue = bySource('ROOM');
  const extrasRevenue = bySource('EXTRAS');
  const otherRevenue = bySource('OTHER');
  const serviceCharge = sum(
    revenue.map((line) => money(line.serviceChargeMinor, currency)),
    currency,
  );
  const outputVat = sum(
    revenue.map((line) => money(line.vatMinor, currency)),
    currency,
  );

  const totalRevenue = add(add(add(roomRevenue, extrasRevenue), otherRevenue), serviceCharge);

  const deductible = expenses.filter((line) => line.isDeductible);
  const expenseGroups = groupExpenses(deductible, currency);
  const totalExpenses = sum(
    expenseGroups.map((group) => group.amount),
    currency,
  );
  const nonDeductibleExpenses = sum(
    expenses
      .filter((line) => !line.isDeductible)
      .map((line) => money(expenseCostMinor(line), currency)),
    currency,
  );

  const reclaimableInputVat = sum(
    expenses.filter((line) => line.vatClaimable).map((line) => money(line.vatMinor, currency)),
    currency,
  );

  const netProfit = subtract(totalRevenue, totalExpenses);

  return {
    currency,
    roomRevenue,
    extrasRevenue,
    otherRevenue,
    serviceCharge,
    totalRevenue,
    expenseGroups,
    totalExpenses,
    nonDeductibleExpenses,
    netProfit,
    retained: subtract(netProfit, nonDeductibleExpenses),
    outputVat,
    reclaimableInputVat,
    netVatPayable: subtract(outputVat, reclaimableInputVat),
  };
}

/**
 * Roll expenses up by group, then by category within it.
 *
 * Groups come back in `EXPENSE_GROUP_ORDER` and empty ones are dropped: a
 * report listing nine headings for a month with three kinds of spending buries
 * what happened. Categories are ordered largest first, because the question an
 * owner is asking when they open this is "what did I spend the most on".
 */
function groupExpenses(
  lines: readonly ExpenseLine[],
  currency: string,
): readonly ProfitLossGroupTotal[] {
  const groups: ProfitLossGroupTotal[] = [];

  for (const group of EXPENSE_GROUP_ORDER) {
    const inGroup = lines.filter((line) => line.group === group);
    if (inGroup.length === 0) continue;

    const byCategory = new Map<string, ProfitLossCategoryTotal>();
    for (const line of inGroup) {
      const existing = byCategory.get(line.categoryId);
      const amount = money(expenseCostMinor(line), currency);
      byCategory.set(line.categoryId, {
        categoryId: line.categoryId,
        categoryCode: line.categoryCode,
        categoryNameTh: line.categoryNameTh,
        categoryNameEn: line.categoryNameEn,
        amount: existing ? add(existing.amount, amount) : amount,
      });
    }

    const categories = [...byCategory.values()].sort(
      (a, b) => b.amount.amount - a.amount.amount || a.categoryCode.localeCompare(b.categoryCode),
    );

    groups.push({
      group,
      categories,
      amount: sum(
        categories.map((category) => category.amount),
        currency,
      ),
    });
  }

  return groups;
}
