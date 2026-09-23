import { applyBasisPoints, money, subtract, type Money } from '@deehub/shared';
import { computeBreakdown } from '../../reservations/domain/pricing';

/**
 * The arithmetic of a bill the hotel pays (docs/accounting-plan.md §4).
 *
 * Pure: no database, no clock, no DI. An owner will argue with every number
 * here, so it has to be readable on its own and testable without a running
 * system — the same rule `folio.ts` follows.
 *
 * **There is no VAT formula in this file.** Splitting tax out of a gross
 * amount is `computeBreakdown` with the service charge set to zero, which is
 * the one implementation of Thai tax composition the codebase has
 * (`reservations/domain/pricing.ts`). A second one written here would round
 * differently in some month nobody is watching, and then a purchase invoice
 * would disagree with a sales invoice by a satang for reasons no one could
 * reconstruct.
 */

export const EXPENSE_KINDS = ['EXPENSE', 'VENDOR_CREDIT_NOTE'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const EXPENSE_PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'PROMPTPAY',
  'CARD',
  'CHEQUE',
  'OTHER',
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const SUPPLIER_DOC_TYPES = ['TAX_INVOICE', 'RECEIPT', 'INVOICE', 'NONE'] as const;
export type SupplierDocType = (typeof SUPPLIER_DOC_TYPES)[number];

/**
 * Withholding is not required on a payment below 1,000 baht.
 *
 * Per contract rather than per payment: a 500-baht monthly retainer under one
 * annual agreement is not exempt just because each instalment is small. Nothing
 * here knows about contracts, so this only ever *suggests* zero — the rate on
 * the expense is what gets filed, and the owner can set it.
 */
export const WHT_EXEMPTION_THRESHOLD_MINOR = 100_000;

/** How much VAT sits inside, or on top of, an amount. */
export interface VatSplit {
  /** Before VAT. The figure that reaches the profit and loss. */
  readonly net: Money;
  readonly vat: Money;
  /** What the supplier billed. */
  readonly gross: Money;
}

/**
 * VAT-only composition: rate → tax, with no service charge in between.
 *
 * A supplier's invoice has no 10% service charge on it; only the hotel's own
 * sales do. Passing zero here is what makes `computeBreakdown` answer the
 * simpler question without a second implementation existing.
 */
function vatOnly(taxRateBp: number, pricesIncludeTax: boolean) {
  return { taxRateBp, serviceChargeRateBp: 0, pricesIncludeTax };
}

/**
 * Pull the VAT out of a total read off a receipt.
 *
 * This is the direction that matters for usability: an owner holds a piece of
 * paper that says 1,070 and should not have to work out that 70 of it is tax.
 * They type what they can see.
 */
export function splitVatFromGross(
  grossMinor: number,
  vatRateBp: number,
  currency: string,
): VatSplit {
  const gross = money(grossMinor, currency);
  if (vatRateBp === 0) {
    return { net: gross, vat: money(0, currency), gross };
  }
  const breakdown = computeBreakdown([gross], currency, vatOnly(vatRateBp, true));
  return { net: breakdown.subtotal, vat: breakdown.tax, gross: breakdown.total };
}

/** Add VAT to a net figure, for the supplier who quotes before tax. */
export function addVatToNet(netMinor: number, vatRateBp: number, currency: string): VatSplit {
  const net = money(netMinor, currency);
  if (vatRateBp === 0) {
    return { net, vat: money(0, currency), gross: net };
  }
  const breakdown = computeBreakdown([net], currency, vatOnly(vatRateBp, false));
  return { net: breakdown.subtotal, vat: breakdown.tax, gross: breakdown.total };
}

/**
 * Tax to withhold from a payment.
 *
 * **The base is the amount before VAT.** Withholding is calculated on the value
 * of the service, not on the tax charged on it — a 3% deduction taken off the
 * VAT-inclusive total over-withholds, short-pays the supplier, and puts a wrong
 * figure on the certificate the supplier will use to claim the credit back.
 * That is a dispute with a supplier and an incorrect ภ.ง.ด.3, from one line of
 * arithmetic.
 */
export function computeWithholding(netMinor: number, rateBp: number, currency: string): Money {
  if (rateBp === 0) return money(0, currency);
  return applyBasisPoints(money(netMinor, currency), rateBp);
}

/**
 * The rate to offer for a bill of this size, given the category's usual rate.
 *
 * Returns zero below the threshold rather than a small deduction nobody is
 * required to make, because over-withholding is worse than not withholding:
 * the money has left for the Revenue Department and the supplier has to be
 * made whole out of the hotel's own pocket.
 */
export function suggestWithholdingRateBp(netMinor: number, categoryRateBp: number): number {
  if (categoryRateBp === 0) return 0;
  return netMinor < WHT_EXEMPTION_THRESHOLD_MINOR ? 0 : categoryRateBp;
}

export interface ExpenseAmountsInput {
  /** What the owner typed, and which end of the bill it came from. */
  readonly amountMinor: number;
  readonly amountIs: 'GROSS' | 'NET';
  readonly vatRateBp: number;
  readonly whtRateBp: number;
  readonly currency: string;
}

export interface ExpenseAmounts {
  readonly net: Money;
  readonly vat: Money;
  readonly gross: Money;
  readonly wht: Money;
  /** What the supplier actually receives. */
  readonly paid: Money;
}

export class ExpenseAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpenseAmountError';
  }
}

/**
 * Every money column on an expense row, from the two numbers a person types.
 *
 * The identities `gross = net + vat` and `paid = gross - wht` are asserted here
 * as well as in the database. The `CHECK` constraint is the guarantee; this is
 * the one that can say which number was wrong, to someone who still has the
 * receipt in their hand.
 */
export function computeExpenseAmounts(input: ExpenseAmountsInput): ExpenseAmounts {
  const { amountMinor, amountIs, vatRateBp, whtRateBp, currency } = input;

  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ExpenseAmountError(`Expense amount must be a positive integer, got ${amountMinor}`);
  }
  if (vatRateBp < 0 || vatRateBp > 10_000) {
    throw new ExpenseAmountError(`VAT rate out of range: ${vatRateBp} basis points`);
  }
  if (whtRateBp < 0 || whtRateBp > 10_000) {
    throw new ExpenseAmountError(`Withholding rate out of range: ${whtRateBp} basis points`);
  }

  const split =
    amountIs === 'GROSS'
      ? splitVatFromGross(amountMinor, vatRateBp, currency)
      : addVatToNet(amountMinor, vatRateBp, currency);

  const wht = computeWithholding(split.net.amount, whtRateBp, currency);

  /*
   * Withholding is a slice of the bill, never more than the bill. It cannot
   * happen with a sane rate — but the rate is editable, and a paid amount below
   * zero would mean the system is claiming the supplier owes the hotel money
   * for having sold it something.
   */
  if (wht.amount > split.gross.amount) {
    throw new ExpenseAmountError(
      `Withholding ${wht.amount} exceeds the amount payable ${split.gross.amount}`,
    );
  }

  return { ...split, wht, paid: subtract(split.gross, wht) };
}
