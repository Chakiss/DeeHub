import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channels } from './channel';
import { organizations } from './identity';
import { properties, roomTypes } from './property';

/**
 * ARI pushes waiting to happen, for a deployment with no Redis.
 *
 * The event-driven sync engine debounces in Redis and pushes from an
 * always-on worker (architecture.md §5). A deployment that has switched
 * that off — to save the $80 a month it costs — still has channels that
 * must hear about a change, so the relay records the change HERE instead
 * of enqueueing it, and the maintenance job drains the table on its
 * schedule. Same push, same idempotency (absolute state), just later.
 *
 * One row per change; the drainer groups by channel and room type and unions
 * the date spans, which is the debounce.
 */
export const ariSyncRequests = pgTable(
  'ari_sync_requests',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    dateFrom: date('date_from').notNull(),
    /** Inclusive. */
    dateTo: date('date_to').notNull(),
    status: text('status').notNull().default('PENDING'),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
  },
  (t) => [
    check('ari_sync_requests_status_ck', sql`${t.status} IN ('PENDING','PUSHED','ABANDONED')`),
    check('ari_sync_requests_dates_ck', sql`${t.dateTo} >= ${t.dateFrom}`),
    index('ari_sync_requests_pending_idx')
      .on(t.channelId, t.roomTypeId, t.requestedAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);
