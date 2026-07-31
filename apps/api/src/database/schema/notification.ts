import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';
import { properties } from './property';

/** See docs/database.md §11. */

/**
 * Messages the system owes somebody, and what happened to each.
 *
 * A queue in Postgres rather than in Redis, for the same reason the outbox is:
 * a deployment with no Redis still books rooms, and a guest still expects a
 * confirmation. The rendered subject and body are STORED rather than
 * re-rendered at send time, so what the log shows is what was sent — a template
 * fixed next week must not rewrite the history of what a guest was told.
 *
 * No foreign key to the reservation on purpose: `reservationId` is context for
 * a message that has already gone out, and a cascade must never erase the
 * record that it did.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    /** What happened, e.g. 'BOOKING_CONFIRMED'. */
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    /** GUEST or STAFF — who the message is for, not who it is about. */
    audience: text('audience').notNull(),
    /** Email address or LINE target. Frozen at enqueue time. */
    recipient: text('recipient').notNull(),
    locale: text('locale').notNull().default('en'),
    subject: text('subject'),
    body: text('body').notNull(),
    status: text('status').notNull().default('PENDING'),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
    /**
     * Why nothing was sent, for a SKIPPED row: no provider configured, no
     * address on file. A message nobody received must say so out loud rather
     * than look identical to one that went out.
     */
    skippedReason: text('skipped_reason'),
    reservationId: uuid('reservation_id'),
    /** Free-form context for the log screen — the booking code, the dates. */
    context: jsonb('context'),
    /**
     * One message per thing that happened.
     *
     * The outbox relay is at-least-once by construction, so the same
     * reservation event can be processed twice; without this a guest gets two
     * confirmations for one booking.
     */
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_uq').on(t.organizationId, t.dedupeKey),
    check('notifications_status_ck', sql`${t.status} IN ('PENDING','SENT','FAILED','SKIPPED')`),
    check('notifications_channel_ck', sql`${t.channel} IN ('EMAIL','LINE')`),
    check('notifications_audience_ck', sql`${t.audience} IN ('GUEST','STAFF')`),
    // Dispatcher hot path: pending rows, oldest first. Partial, so it stays
    // small however many messages have already been delivered.
    index('notifications_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'PENDING'`),
    index('notifications_property_time_idx').on(t.propertyId, t.createdAt.desc()),
  ],
);
