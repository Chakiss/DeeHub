import { add, applyBasisPoints, money, subtract, sum, type Money } from '@deehub/shared';

/**
 * Price composition for a stay (ADR-0003).
 *
 * Thai hotels charge in a specific order: room rate, then 10% service charge,
 * then 7% VAT on the SUM of the two. VAT applied to the bare room rate would
 * understate the bill, so the order is a domain rule, not an implementation
 * detail.
 *
 * All arithmetic is integer minor units. Nothing here uses a float.
 */

export interface TaxConfig {
  /** Basis points, e.g. 700 = 7% VAT. */
  readonly taxRateBp: number;
  /** Basis points, e.g. 1000 = 10% service charge. */
  readonly serviceChargeRateBp: number;
  /** When true, the configured rates are gross: the guest pays exactly the rate. */
  readonly pricesIncludeTax: boolean;
}

export interface PriceBreakdown {
  /** Net room revenue, before service charge and tax. */
  readonly subtotal: Money;
  readonly serviceCharge: Money;
  readonly tax: Money;
  readonly total: Money;
}

const BP_SCALE = 10_000;

function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Remove a basis-point markup: `gross / (1 + bp/10000)`.
 *
 * Done as one multiply and one divide, each staying well inside safe integer
 * range. Multiplying by 10^8 up front would overflow Number.MAX_SAFE_INTEGER
 * on large group bookings.
 */
function removeMarkup(amount: number, basisPoints: number): number {
  return roundHalfUp((amount * BP_SCALE) / (BP_SCALE + basisPoints));
}

export function computeBreakdown(
  nightPrices: readonly Money[],
  currency: string,
  config: TaxConfig,
): PriceBreakdown {
  const lineTotal = sum(nightPrices, currency);

  if (!config.pricesIncludeTax) {
    const subtotal = lineTotal;
    const serviceCharge = applyBasisPoints(subtotal, config.serviceChargeRateBp);
    // VAT applies to room + service charge, per Thai practice.
    const tax = applyBasisPoints(add(subtotal, serviceCharge), config.taxRateBp);
    return {
      subtotal,
      serviceCharge,
      tax,
      total: add(add(subtotal, serviceCharge), tax),
    };
  }

  // Tax-inclusive: the guest pays exactly `lineTotal`, so we invert the
  // markups in reverse order (VAT was applied last, so it comes off first).
  const gross = lineTotal;
  const netPlusServiceCharge = money(removeMarkup(gross.amount, config.taxRateBp), currency);
  const subtotal = money(
    removeMarkup(netPlusServiceCharge.amount, config.serviceChargeRateBp),
    currency,
  );

  // The derived components absorb all rounding so the components always sum to
  // the gross exactly. A folio that is one satang off its own line items is a
  // folio the hotel cannot reconcile.
  const serviceCharge = subtract(netPlusServiceCharge, subtotal);
  const tax = subtract(gross, netPlusServiceCharge);

  return { subtotal, serviceCharge, tax, total: gross };
}
