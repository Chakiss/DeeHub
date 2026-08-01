/**
 * Folio vocabulary, in a module a CLIENT component may import.
 *
 * `lib/api.ts` is `server-only`, so a form that renders a dropdown of charge
 * kinds cannot get the list from there — importing it pulls the whole API
 * client into the browser bundle and the build fails. Same reason
 * `channel-types.ts` and `meal-plans.ts` exist.
 *
 * These must match the API's `FOLIO_CHARGE_KINDS` and `FOLIO_PAYMENT_METHODS`,
 * which are enforced by a database CHECK constraint — a value that drifts here
 * is refused by Postgres rather than silently stored.
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
  /** The OTA collected from the guest; the hotel is owed by the OTA, not them. */
  'OTA_COLLECT',
  /** Billed to a company account, settled later. */
  'CITY_LEDGER',
] as const;

export type FolioPaymentMethod = (typeof FOLIO_PAYMENT_METHODS)[number];

export type FolioPaymentKind = 'PAYMENT' | 'REFUND';
