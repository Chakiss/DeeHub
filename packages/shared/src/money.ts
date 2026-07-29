/**
 * Money value object (ADR-0003).
 *
 * Amounts are ALWAYS integer minor units (satang for THB, cents for USD).
 * Floating-point money is a bug, not a style preference: 0.1 + 0.2 !== 0.3,
 * and a hotel folio that is off by one satang is a folio nobody trusts.
 */

export interface Money {
  /** Integer minor units. 250000 = ฿2,500.00 */
  readonly amount: number;
  /** ISO 4217, uppercase. */
  readonly currency: string;
}

/** Currencies whose minor unit is not 1/100. Extend as markets are added. */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  IDR: 2,
  THB: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  MYR: 2,
};

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function money(amount: number, currency: string): Money {
  const normalized = currency.toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    throw new MoneyError(`Invalid ISO 4217 currency code: "${currency}"`);
  }
  if (!Number.isInteger(amount)) {
    throw new MoneyError(
      `Money amount must be an integer in minor units, received ${amount}. ` +
        `Did you pass a major-unit (decimal) value?`,
    );
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(`Money amount ${amount} exceeds the safe integer range`);
  }
  return Object.freeze({ amount, currency: normalized });
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export function isZero(value: Money): boolean {
  return value.amount === 0;
}

export function isNegative(value: Money): boolean {
  return value.amount < 0;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    // No implicit conversion, ever. v1 has no exchange rates (ADR-0003),
    // and silently mixing currencies would corrupt a folio total.
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function sum(values: readonly Money[], currency: string): Money {
  return values.reduce<Money>((acc, value) => add(acc, value), zero(currency));
}

/** Multiply by a whole number of units (e.g. nights, rooms). */
export function multiply(value: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new MoneyError(`Money multiplier must be an integer, received ${factor}`);
  }
  return money(value.amount * factor, value.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

/**
 * Round half away from zero. Math.round() is biased for negatives
 * (Math.round(-0.5) === -0), which would make a refund and a charge of the
 * same magnitude round differently.
 */
function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Apply a rate expressed in basis points (700 = 7.00%).
 *
 * Basis points keep tax and service-charge arithmetic exact: Thai VAT of 7%
 * on ฿2,500.00 is 700 bp of 250000 = 17500 satang, with no float involved.
 */
export function applyBasisPoints(value: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError(`Basis points must be an integer, received ${basisPoints}`);
  }
  return money(roundHalfUp((value.amount * basisPoints) / 10_000), value.currency);
}

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

/** Convert to major units for display only. Never use the result in arithmetic. */
export function toMajorUnits(value: Money): number {
  return value.amount / 10 ** minorUnitExponent(value.currency);
}

/** Build Money from a major-unit decimal (user input, OTA payloads). */
export function fromMajorUnits(amount: number, currency: string): Money {
  const factor = 10 ** minorUnitExponent(currency);
  const minor = roundHalfUp(amount * factor);
  return money(minor, currency);
}

export function format(value: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: minorUnitExponent(value.currency),
  }).format(toMajorUnits(value));
}
