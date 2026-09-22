import { sql } from 'drizzle-orm';
import {
  boolean,
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

/**
 * Where a booking came through — Agoda, Booking.com, a travel agent the hotel
 * has a contract with. See docs/database.md §8a and ADR-0009.
 *
 * NOT a channel. A `channels` row is a connector: credentials, mappings, a
 * sync queue, one ACTIVE per type. This is a label the front desk picks when
 * it keys in a booking that arrived by extranet or by phone from an agent,
 * and the thing reports group revenue by. A property has these long before it
 * has a connector, and keeps the agents that will never be one.
 *
 * `channel_type` ties a row to a connector type so that when a real connector
 * is switched on, the bookings it delivers land under the same label the desk
 * has been using by hand — one column to report on, not two.
 */
export const bookingSources = pgTable(
  'booking_sources',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    channelType: text('channel_type'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('booking_sources_property_name_uq').on(t.propertyId, sql`lower(${t.name})`),
    uniqueIndex('booking_sources_property_channel_type_uq')
      .on(t.propertyId, t.channelType)
      .where(sql`${t.channelType} IS NOT NULL`),
    index('booking_sources_property_idx').on(t.propertyId, t.isActive),
    check('booking_sources_kind_ck', sql`${t.kind} IN ('OTA','TRAVEL_AGENT')`),
    check(
      'booking_sources_channel_type_ck',
      sql`${t.channelType} IS NULL OR ${t.channelType} IN ('MOCK_OTA','AGODA','BOOKING_COM','EXPEDIA','TRIP_COM','AIRBNB','DIRECT')`,
    ),
  ],
);
