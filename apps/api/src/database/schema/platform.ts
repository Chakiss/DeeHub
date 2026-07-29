import { sql } from 'drizzle-orm';
import {
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** See docs/database.md §10. */

/**
 * Append-only audit trail.
 *
 * Deliberately has NO foreign keys: an audit record must survive deletion of
 * whatever it describes, and referential integrity would let a cascade erase
 * the evidence.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    propertyId: uuid('property_id'),
    actorType: text('actor_type').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorLabel: text('actor_label'),
    /** Dotted action name, e.g. 'reservation.cancelled'. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('audit_logs_actor_type_ck', sql`${t.actorType} IN ('USER','SYSTEM','CHANNEL')`),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
    index('audit_logs_org_time_idx').on(t.organizationId, t.createdAt.desc()),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt.desc()),
  ],
);

/**
 * Transactional outbox.
 *
 * Events are inserted in the SAME transaction as the state change, then
 * relayed to BullMQ. Enqueueing directly from a service would allow a crash
 * between commit and enqueue to leave OTAs permanently stale — a silent
 * overbooking risk (architecture.md §5).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    propertyId: uuid('property_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    // Relay hot path: unpublished rows only, oldest first. Partial index keeps
    // it small no matter how many events have already been published.
    index('outbox_unpublished_idx')
      .on(t.occurredAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);

/**
 * Idempotency records for retry-safe mutations.
 *
 * A network timeout on a booking request is indistinguishable from a failure;
 * without this table the client's retry would double-book a room.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idempotency_keys_expiry_idx').on(t.expiresAt)],
);
