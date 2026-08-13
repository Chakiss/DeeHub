import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';
import { properties, ratePlans, roomTypes } from './property';
import { encryptedBytes } from './guest';

/** See docs/database.md §9. */

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    /** Envelope-encrypted. Write-only through the API; never returned. */
    credentialsEncrypted: encryptedBytes('credentials_encrypted'),
    settings: jsonb('settings')
      .notNull()
      .default(sql`'{}'::jsonb`),
    syncHorizonDays: smallint('sync_horizon_days').notNull().default(365),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channels_property_type_active_uq')
      .on(t.propertyId, t.type)
      .where(sql`${t.status} <> 'INACTIVE'`),
    check(
      'channels_type_ck',
      sql`${t.type} IN ('MOCK_OTA','AGODA','BOOKING_COM','EXPEDIA','TRIP_COM','AIRBNB','DIRECT')`,
    ),
    check('channels_status_ck', sql`${t.status} IN ('ACTIVE','INACTIVE','ERROR')`),
    check('channels_horizon_ck', sql`${t.syncHorizonDays} BETWEEN 1 AND 730`),
  ],
);

export const channelRoomTypeMappings = pgTable(
  'channel_room_type_mappings',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    externalRoomId: text('external_room_id').notNull(),
    externalRoomName: text('external_room_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crtm_channel_roomtype_uq').on(t.channelId, t.roomTypeId),
    uniqueIndex('crtm_channel_external_uq').on(t.channelId, t.externalRoomId),
  ],
);

export const channelRatePlanMappings = pgTable(
  'channel_rate_plan_mappings',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'restrict' }),
    externalRateId: text('external_rate_id').notNull(),
    externalRateName: text('external_rate_name'),
    /**
     * Markup applied to this plan's price before it is pushed to this channel,
     * in basis points: 10000 = ×1.0 (unchanged), 18000 = ×1.8.
     *
     * Basis points rather than a decimal factor for the same reason tax and
     * service charge are (`properties.tax_rate_bp`): the arithmetic stays in
     * integers, and money never passes through a float.
     *
     * See docs/channel-markup-plan.md.
     */
    rateMultiplierBp: integer('rate_multiplier_bp').notNull().default(10000),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crpm_channel_rateplan_uq').on(t.channelId, t.ratePlanId),
    uniqueIndex('crpm_channel_external_uq').on(t.channelId, t.externalRateId),
    // Upper bound as much as lower: a factor typed with an extra zero would
    // push a ฿1,800 room to an OTA at ฿18,000 and nothing downstream would
    // question it.
    check('crpm_multiplier_ck', sql`${t.rateMultiplierBp} BETWEEN 1 AND 100000`),
  ],
);

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    roomTypeId: uuid('room_type_id').references(() => roomTypes.id, { onDelete: 'cascade' }),
    dateFrom: date('date_from'),
    dateTo: date('date_to'),
    status: text('status').notNull().default('QUEUED'),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('sync_jobs_kind_ck', sql`${t.kind} IN ('ARI_PUSH','RESERVATION_PULL','FULL_SYNC')`),
    check(
      'sync_jobs_status_ck',
      sql`${t.status} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER')`,
    ),
    check(
      'sync_jobs_date_order_ck',
      sql`${t.dateTo} IS NULL OR ${t.dateFrom} IS NULL OR ${t.dateTo} >= ${t.dateFrom}`,
    ),
    index('sync_jobs_channel_status_idx').on(t.channelId, t.status, t.scheduledAt),
    // Sync-latency dashboard and stalled-sync alerting.
    index('sync_jobs_completed_idx').on(t.channelId, t.completedAt.desc()),
  ],
);
