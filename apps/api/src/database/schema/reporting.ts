import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';
import { properties, roomTypes } from './property';

/** See docs/database.md §10.1. */

/**
 * What was on the books, as of a past business date.
 *
 * Every other figure in the product is derived from live reservations, and
 * pickup cannot be: it asks "how much business did we take for next weekend
 * DURING the last seven days", and today's rows do not remember when they
 * arrived. Deriving it from `reservations.created_at` almost works and is
 * wrong in exactly the cases a revenue manager is looking at — a booking made
 * on Monday and cancelled on Wednesday was genuinely on the books on Tuesday,
 * and a stay whose dates moved was never on the books for the dates it now
 * holds.
 *
 * So a snapshot, written once per property per business date by the
 * maintenance job. One row per room type per stay date; absence means zero.
 *
 * **This starts accumulating the day it is switched on.** There is no history
 * before the first snapshot and none can be reconstructed, which is the price
 * of not having kept one. The pickup report says which baseline it actually
 * found rather than quietly comparing against nothing.
 */
export const otbSnapshots = pgTable(
  'otb_snapshots',
  {
    /**
     * CASCADE, unlike every business table, which uses RESTRICT.
     *
     * RESTRICT exists to stop an organization being deleted while records that
     * mean something still point at it. A snapshot means nothing on its own —
     * it is a derived copy of reservations that are themselves protected — so
     * blocking a deletion on one would be a false alarm.
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    /**
     * The business date this was taken on, in the PROPERTY's timezone
     * (ADR-0003) — not a UTC timestamp. A snapshot taken at 00:30 Bangkok time
     * belongs to that day's trading, and a UTC date would file it under the
     * previous one for every property east of Greenwich.
     */
    asOf: date('as_of').notNull(),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    stayDate: date('stay_date').notNull(),
    roomsSold: integer('rooms_sold').notNull(),
    revenueMinor: bigint('revenue_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Natural key, no surrogate id: nothing references a snapshot row, and the
    // key is what makes the daily capture idempotent under ON CONFLICT.
    primaryKey({ columns: [t.propertyId, t.asOf, t.roomTypeId, t.stayDate] }),
    // The read path: one stay date, every baseline ever taken for it.
    index('otb_snapshots_stay_idx').on(t.propertyId, t.stayDate, t.asOf),
  ],
);
