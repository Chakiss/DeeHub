import { add, money, subtract, sum, type IsoDate, type Money } from '@deehub/shared';
import { computeBreakdown, type TaxConfig } from '../../reservations/domain/pricing';

/**
 * What a guest owes and what they have paid (roadmap Phase 4).
 *
 * Pure arithmetic over already-loaded rows: no database, no clock, no DI. A
 * hotelier will want to argue with every line of this, so it has to be readable
 * on its own and testable without a running system — the same rule the
 * notification templates follow.
 */

export const FOLIO_CHARGE_KINDS = [
  'FOOD_AND_BEVERAGE',
  'MINIBAR',
  'LAUNDRY',
  'TRANSFER',
  'LATE_CHECKOUT',
  'DAMAGE',
  'OTHER',
] as const;
export type FolioChargeKind = (typeof FOLIO_CHARGE_KINDS)[number];

export const FOLIO_PAYMENT_METHODS = [
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'PROMPTPAY',
  'OTA_COLLECT',
  'CITY_LEDGER',
] as const;
export type FolioPaymentMethod = (typeof FOLIO_PAYMENT_METHODS)[number];

export const FOLIO_PAYMENT_KINDS = ['PAYMENT', 'REFUND'] as const;
export type FolioPaymentKind = (typeof FOLIO_PAYMENT_KINDS)[number];

/** One night of the stay, at the price the guest was quoted. */
export interface RoomChargeLine {
  readonly date: IsoDate;
  readonly stayId: string;
  readonly roomTypeName: string;
  readonly amountMinor: number;
}

export interface ExtraChargeLine {
  readonly id: string;
  readonly kind: FolioChargeKind;
  readonly description: string | null;
  readonly amountMinor: number;
  readonly taxable: boolean;
  readonly businessDate: IsoDate;
  readonly postedAt: Date;
  readonly postedBy: string | null;
  readonly voidedAt: Date | null;
  readonly voidedReason: string | null;
}

export interface PaymentLine {
  readonly id: string;
  readonly kind: FolioPaymentKind;
  readonly method: FolioPaymentMethod;
  readonly amountMinor: number;
  readonly reference: string | null;
  readonly businessDate: IsoDate;
  readonly recordedAt: Date;
  readonly recordedBy: string | null;
  readonly voidedAt: Date | null;
  readonly voidedReason: string | null;
}

export interface FolioTotals {
  /** Room nights plus taxable extras, before service charge and tax. */
  readonly roomSubtotal: Money;
  readonly extrasSubtotal: Money;
  readonly serviceCharge: Money;
  readonly tax: Money;
  /** Charges that carry no tax at all, added after the breakdown. */
  readonly untaxedExtras: Money;
  readonly chargesTotal: Money;
  readonly paid: Money;
  readonly refunded: Money;
  /**
   * What is still owed. Negative means the hotel owes the guest, which happens
   * for real — a prepaid stay cut short, a double payment — and is shown as a
   * negative balance rather than clamped to zero.
   */
  readonly balance: Money;
}

/**
 * Add the account up.
 *
 * **Extras go through the same tax composition as room nights, not alongside
 * it.** Thai practice is rate, then service charge, then VAT on the sum
 * (`computeBreakdown`), and running extras through a second, separate
 * calculation would round each of them independently — producing a total a
 * baht or two away from the one a guest gets by adding the printed lines.
 *
 * **A voided line contributes nothing and is still returned.** Dropping it
 * would make the folio agree with itself and disagree with the drawer; whoever
 * is looking at a folio that does not balance needs to see what was reversed.
 */
export function computeTotals(
  roomCharges: readonly RoomChargeLine[],
  extras: readonly ExtraChargeLine[],
  payments: readonly PaymentLine[],
  currency: string,
  config: TaxConfig,
): FolioTotals {
  const live = extras.filter((extra) => extra.voidedAt === null);
  const taxable = live.filter((extra) => extra.taxable);
  const untaxed = live.filter((extra) => !extra.taxable);

  const roomLines = roomCharges.map((line) => money(line.amountMinor, currency));
  const taxableLines = taxable.map((extra) => money(extra.amountMinor, currency));

  const breakdown = computeBreakdown([...roomLines, ...taxableLines], currency, config);

  /*
   * The breakdown reports ONE subtotal over everything it was given, and a
   * folio has to show rooms and extras on separate lines. Splitting it by
   * proportion would drift; instead the extras' share is recomputed the same
   * way and rooms take the remainder, so the two always add back to the
   * subtotal the tax was actually calculated on.
   */
  const extrasOnly = computeBreakdown(taxableLines, currency, config);
  const extrasSubtotal = extrasOnly.subtotal;
  const roomSubtotal = subtract(breakdown.subtotal, extrasSubtotal);

  const untaxedExtras = sum(
    untaxed.map((extra) => money(extra.amountMinor, currency)),
    currency,
  );
  const chargesTotal = add(breakdown.total, untaxedExtras);

  const livePayments = payments.filter((payment) => payment.voidedAt === null);
  const paid = sum(
    livePayments
      .filter((payment) => payment.kind === 'PAYMENT')
      .map((payment) => money(payment.amountMinor, currency)),
    currency,
  );
  const refunded = sum(
    livePayments
      .filter((payment) => payment.kind === 'REFUND')
      .map((payment) => money(payment.amountMinor, currency)),
    currency,
  );

  return {
    roomSubtotal,
    extrasSubtotal,
    serviceCharge: breakdown.serviceCharge,
    tax: breakdown.tax,
    untaxedExtras,
    chargesTotal,
    paid,
    refunded,
    // What is owed, net of anything given back.
    balance: subtract(chargesTotal, subtract(paid, refunded)),
  };
}

/**
 * Whether a refund is more than the hotel has actually taken.
 *
 * Refunding money that was never received is not a rounding problem — it is a
 * cashier typing into the wrong booking, and it turns a folio into a claim the
 * hotel owes somebody who has paid nothing.
 */
export function exceedsRefundable(
  requestedMinor: number,
  totals: Pick<FolioTotals, 'paid' | 'refunded'>,
): boolean {
  return requestedMinor > totals.paid.amount - totals.refunded.amount;
}
