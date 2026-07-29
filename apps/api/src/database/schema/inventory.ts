import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';
import { properties, ratePlans, roomTypes } from './property';

/**
 * Inventory — one row per room type per night (ADR-0002).
 *
 * Composite primary key, no surrogate id: nothing references an inventory row
 * by ID and every access path is (room type, date), so the natural key gives
 * one index instead of two and keeps a stay's nights physically adjacent.
 *
 * See docs/database.md §5.
 */
export const inventoryDays = pgTable(
  'inventory_days',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    date: date('date').notNull(),
    /** Sellable units. May exceed the physical room count — overselling is a business decision. */
    allotment: integer('allotment').notNull().default(0),
    /** Units held by inventory-holding reservations. Only the Inventory module writes this. */
    booked: integer('booked').notNull().default(0),
    stopSell: boolean('stop_sell').notNull().default(false),
    minStay: smallint('min_stay').notNull().default(1),
    maxStay: smallint('max_stay'),
    closedToArrival: boolean('closed_to_arrival').notNull().default(false),
    closedToDeparture: boolean('closed_to_departure').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'inventory_days_pk', columns: [t.roomTypeId, t.date] }),

    // THE anti-overbooking guarantee. This holds even if application code is
    // wrong: Postgres will refuse the write rather than oversell a room.
    check('inventory_booked_range_ck', sql`${t.booked} >= 0 AND ${t.booked} <= ${t.allotment}`),
    check('inventory_allotment_nonneg_ck', sql`${t.allotment} >= 0`),
    check('inventory_min_stay_ck', sql`${t.minStay} >= 1`),
    check('inventory_max_stay_ck', sql`${t.maxStay} IS NULL OR ${t.maxStay} >= ${t.minStay}`),

    // Sync engine: "what changed for this property since the last push?"
    index('inventory_days_property_updated_idx').on(t.propertyId, t.updatedAt),
    index('inventory_days_property_date_idx').on(t.propertyId, t.date),
  ],
);

/** Occupancy-based pricing: required by every OTA. See docs/database.md §6. */
export const rateDays = pgTable(
  'rate_days',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    occupancy: smallint('occupancy').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'rate_days_pk', columns: [t.ratePlanId, t.date, t.occupancy] }),
    check('rate_days_occupancy_ck', sql`${t.occupancy} >= 1`),
    check('rate_days_amount_ck', sql`${t.amountMinor} >= 0`),
    index('rate_days_property_updated_idx').on(t.propertyId, t.updatedAt),
    index('rate_days_property_date_idx').on(t.propertyId, t.date),
  ],
);
