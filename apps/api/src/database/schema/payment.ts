import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';
import { properties } from './property';
import { reservations } from './reservation';

export const PAYMENT_METHODS = ['CARD', 'PROMPTPAY'] as const;
export const PAYMENT_INTENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'EXPIRED'] as const;

/**
 * One attempt to pay for a booking online.
 *
 * A folio payment is money that arrived. This is the step before: a charge
 * started with the provider that may still be waiting on a bank (3-D Secure)
 * or on a guest scanning a QR (PromptPay). The provider tells us the outcome
 * later — a webhook, or our own poll — and the row is what lets that arrival
 * find the booking it belongs to, exactly once. `provider_charge_id` is
 * unique per provider for that reason: a webhook delivered twice settles
 * once.
 *
 * Nothing here is the card. Card details never reach this system (the
 * browser tokenises them with the provider), and a PromptPay QR is public by
 * design — it is shown on a screen.
 */
export const paymentIntents = pgTable(
  'payment_intents',
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
    provider: text('provider').notNull(),
    providerChargeId: text('provider_charge_id').notNull(),
    method: text('method').notNull(),
    status: text('status').notNull().default('PENDING'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Where a card holder is sent for 3-D Secure, when the bank asks. */
    authorizeUri: text('authorize_uri'),
    /** The PromptPay QR, as the provider serves it. */
    qrImageUri: text('qr_image_uri'),
    failureReason: text('failure_reason'),
    /** After this the provider will not accept the payment; the row is EXPIRED. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** When the outcome was last asked for, to keep a polling page from hammering the provider. */
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_intents_provider_charge_uq').on(t.provider, t.providerChargeId),
    index('payment_intents_reservation_idx').on(t.reservationId, t.createdAt),
    index('payment_intents_pending_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'PENDING'`),
    check('payment_intents_method_ck', sql`${t.method} IN ('CARD','PROMPTPAY')`),
    check('payment_intents_status_ck', sql`${t.status} IN ('PENDING','PAID','FAILED','EXPIRED')`),
    check('payment_intents_amount_ck', sql`${t.amountMinor} > 0`),
  ],
);
