import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';
import { physicalRooms, properties, ratePlans, roomTypes } from './property';
import { guests } from './guest';
import { channels } from './channel';

/** See docs/database.md §8. */

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    /** Human reference, e.g. DH-8F3K2A. */
    code: text('code').notNull(),
    status: text('status').notNull(),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'restrict' }),
    source: text('source').notNull().default('DIRECT'),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    /** Contact exactly as received. OTA-masked addresses must survive verbatim. */
    bookerName: text('booker_name').notNull(),
    bookerEmail: text('booker_email'),
    bookerPhone: text('booker_phone'),
    currency: char('currency', { length: 3 }).notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    serviceChargeMinor: bigint('service_charge_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    /** PENDING holds expire and release inventory; unbounded holds are a denial vector. */
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    /**
     * When the guest actually arrived and left, as opposed to the dates they
     * booked. Reports on early arrivals, late departures and same-day turnover
     * need the real times, and the audit trail is not a place to aggregate over.
     */
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    specialRequests: text('special_requests'),
    /** Optimistic locking: stops two front-desk staff overwriting each other. */
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reservations_property_code_uq').on(t.propertyId, sql`upper(${t.code})`),
    check(
      'reservations_status_ck',
      sql`${t.status} IN ('PENDING','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW','EXPIRED')`,
    ),
    check('reservations_source_ck', sql`${t.source} IN ('DIRECT','OTA','WALK_IN','PHONE','EMAIL')`),
    check('reservations_hold_ck', sql`${t.status} <> 'PENDING' OR ${t.holdExpiresAt} IS NOT NULL`),
    check('reservations_subtotal_ck', sql`${t.subtotalMinor} >= 0`),
    check('reservations_total_ck', sql`${t.totalMinor} >= 0`),
    index('reservations_property_status_idx').on(t.propertyId, t.status),
    index('reservations_property_created_idx').on(t.propertyId, t.createdAt.desc()),
    index('reservations_guest_idx')
      .on(t.guestId)
      .where(sql`${t.guestId} IS NOT NULL`),
    // The hold-expiry sweeper reads only this tiny slice.
    index('reservations_pending_expiry_idx')
      .on(t.holdExpiresAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

/** One stay = one room unit. Two rooms of the same type produce two stays. */
export const reservationStays = pgTable(
  'reservation_stays',
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
      .references(() => reservations.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'restrict' }),
    checkIn: date('check_in').notNull(),
    checkOut: date('check_out').notNull(),
    adults: smallint('adults').notNull().default(1),
    children: smallint('children').notNull().default(0),
    /** Front-desk assignment, Phase 4. Never affects availability. */
    assignedRoomId: uuid('assigned_room_id').references(() => physicalRooms.id, {
      onDelete: 'set null',
    }),
    guestName: text('guest_name'),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    /**
     * How many nights were handed back because the guest left before using
     * them (`docs/early-checkout-plan.md`). A summary for the desk; WHICH
     * nights is recorded per night, on `reservation_stay_nights.released_early`
     * — a count cannot tell a report grouped by date what to subtract.
     */
    nightsReleasedEarly: smallint('nights_released_early').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stays_date_order_ck', sql`${t.checkOut} > ${t.checkIn}`),
    check('stays_adults_ck', sql`${t.adults} >= 1`),
    check('stays_children_ck', sql`${t.children} >= 0`),
    index('reservation_stays_reservation_idx').on(t.reservationId),
    index('reservation_stays_arrivals_idx').on(t.propertyId, t.checkIn),
    index('reservation_stays_departures_idx').on(t.propertyId, t.checkOut),
  ],
);

/**
 * Materialized nights with FROZEN prices.
 *
 * `amountMinor` is a snapshot taken at booking time. Recomputing it from the
 * rate plan later would silently rewrite what a guest was quoted whenever
 * rates change.
 */
export const reservationStayNights = pgTable(
  'reservation_stay_nights',
  {
    stayId: uuid('stay_id')
      .notNull()
      .references(() => reservationStays.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    // Denormalized so reconciliation and occupancy reports never join upward.
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /**
     * The guest paid for this night and did not occupy it: they left early and
     * the room went back on sale (`docs/early-checkout-plan.md`).
     *
     * The row stays, because the money is real and the folio derives from it.
     * What changes is that the night stops counting as a room sold — whoever
     * bought it afterwards is the one occupying it. Without this flag a night
     * sold twice reads as two rooms out of a property that has one.
     */
    releasedEarly: boolean('released_early').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'reservation_stay_nights_pk', columns: [t.stayId, t.date] }),
    check('rsn_amount_ck', sql`${t.amountMinor} >= 0`),
    index('rsn_property_roomtype_date_idx').on(t.propertyId, t.roomTypeId, t.date),
    index('rsn_reservation_idx').on(t.reservationId),
  ],
);

/** Inbound OTA bookings, stored raw before mapping. Never dropped. */
export const channelReservations = pgTable(
  'channel_reservations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    externalReservationId: text('external_reservation_id').notNull(),
    externalStatus: text('external_status'),
    rawPayload: jsonb('raw_payload').notNull(),
    status: text('status').notNull().default('RECEIVED'),
    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    // Dedupe key: OTAs redeliver. Without this, a redelivery becomes a double booking.
    uniqueIndex('channel_reservations_dedupe_uq').on(t.channelId, t.externalReservationId),
    check(
      'channel_reservations_status_ck',
      sql`${t.status} IN ('RECEIVED','PROCESSED','FAILED','IGNORED')`,
    ),
    index('channel_reservations_unprocessed_idx')
      .on(t.channelId, t.receivedAt)
      .where(sql`${t.status} IN ('RECEIVED','FAILED')`),
  ],
);
