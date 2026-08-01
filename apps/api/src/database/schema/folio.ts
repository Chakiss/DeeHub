import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './identity';
import { properties } from './property';
import { reservations } from './reservation';

/** See docs/database.md §8.1 — the folio belongs to the reservation. */

/**
 * There is no `folios` table, and that is a decision rather than an omission.
 *
 * One booking has one account, so a folio row would carry an id, a reservation
 * id and nothing else — a join to reach the same rows, and a second thing that
 * could fail to exist. Splitting a bill between a company and a guest is real
 * and would need one; it is not built, and when it is, this is where it goes.
 *
 * **Room charges are not stored here either.** They are derived from the
 * reservation's frozen night prices, which already exist and already move
 * correctly when a stay is extended, shortened or cancelled. Copying them into
 * a ledger would create two numbers that must agree and a reconciliation bug
 * the first time one of those operations forgot to update the copy.
 *
 * The trade is real and worth stating: a true posted-charge ledger is what a
 * night audit needs to freeze a day's revenue, and this cannot do that yet.
 * What it can do is tell a front desk what the guest owes right now.
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

/** Anything the guest is charged for that is not a room night. */
export const folioCharges = pgTable(
  'folio_charges',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    description: text('description'),
    /** Positive. A charge that should not have been made is VOIDED, not negated. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /**
     * Whether the property's tax and service charge apply.
     *
     * True for almost everything a hotel sells. False exists for the lines that
     * are not sales — a damage recovery, a pass-through — where adding VAT
     * would overcharge the guest and misstate the property's output tax.
     */
    taxable: boolean('taxable').notNull().default(true),
    /**
     * The property-timezone date this belongs to (ADR-0003), not a timestamp.
     * A charge posted at 00:30 belongs to that day's trading; a UTC date would
     * file it under the previous one for every property east of Greenwich.
     */
    businessDate: date('business_date').notNull(),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Voided, never deleted. A line that vanishes takes the evidence with it,
     * and "this was charged and then reversed" is a different fact from "this
     * was never charged" — which is exactly the difference somebody is looking
     * for when a till does not balance.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedReason: text('voided_reason'),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check('folio_charges_amount_ck', sql`${t.amountMinor} > 0`),
    check(
      'folio_charges_kind_ck',
      sql`${t.kind} IN ('FOOD_AND_BEVERAGE','MINIBAR','LAUNDRY','TRANSFER','LATE_CHECKOUT','DAMAGE','OTHER')`,
    ),
    // A void has to say who and why, or the trail records nothing useful.
    check('folio_charges_void_ck', sql`(${t.voidedAt} IS NULL) = (${t.voidedReason} IS NULL)`),
    index('folio_charges_reservation_idx').on(t.reservationId, t.postedAt),
    // The cashier report: one property, one trading day.
    index('folio_charges_business_date_idx').on(t.propertyId, t.businessDate),
  ],
);

/** Money that moved, in either direction. */
export const folioPayments = pgTable(
  'folio_payments',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'restrict' }),
    /**
     * PAYMENT or REFUND, both with a POSITIVE amount.
     *
     * A refund as a negative payment would be shorter and is the reason cash
     * reports come out wrong: "total taken today" becomes a net figure that
     * hides both sides, and a cashier counting a drawer needs the two apart.
     */
    kind: text('kind').notNull(),
    method: text('method').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Card approval code, transfer slip, OTA reference. */
    reference: text('reference'),
    businessDate: date('business_date').notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedReason: text('voided_reason'),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check('folio_payments_amount_ck', sql`${t.amountMinor} > 0`),
    check('folio_payments_kind_ck', sql`${t.kind} IN ('PAYMENT','REFUND')`),
    check(
      'folio_payments_method_ck',
      sql`${t.method} IN ('CASH','CARD','BANK_TRANSFER','PROMPTPAY','OTA_COLLECT','CITY_LEDGER')`,
    ),
    check('folio_payments_void_ck', sql`(${t.voidedAt} IS NULL) = (${t.voidedReason} IS NULL)`),
    index('folio_payments_reservation_idx').on(t.reservationId, t.recordedAt),
    // Who took what, on which day, by which method — the cashier reconciliation.
    index('folio_payments_business_date_idx').on(t.propertyId, t.businessDate),
  ],
);
