import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';

/** See docs/database.md §4. */

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** IANA timezone. Every business date in this property is computed from it (ADR-0003). */
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    currency: char('currency', { length: 3 }).notNull().default('THB'),
    country: char('country', { length: 2 }).notNull().default('TH'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    postalCode: text('postal_code'),
    phone: text('phone'),
    email: text('email'),
    checkInTime: time('check_in_time').notNull().default('14:00'),
    checkOutTime: time('check_out_time').notNull().default('12:00'),
    /** Basis points: 700 = 7% Thai VAT. Integer arithmetic only. */
    taxRateBp: integer('tax_rate_bp').notNull().default(700),
    serviceChargeRateBp: integer('service_charge_rate_bp').notNull().default(1000),
    pricesIncludeTax: boolean('prices_include_tax').notNull().default(false),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('properties_org_code_uq').on(t.organizationId, sql`lower(${t.code})`),
    check('properties_status_ck', sql`${t.status} IN ('ACTIVE','INACTIVE')`),
    check('properties_tax_rate_ck', sql`${t.taxRateBp} BETWEEN 0 AND 10000`),
    check('properties_service_charge_ck', sql`${t.serviceChargeRateBp} BETWEEN 0 AND 10000`),
  ],
);

export const roomTypes = pgTable(
  'room_types',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    standardOccupancy: smallint('standard_occupancy').notNull().default(2),
    maxOccupancy: smallint('max_occupancy').notNull().default(2),
    maxAdults: smallint('max_adults').notNull().default(2),
    maxChildren: smallint('max_children').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_types_property_code_uq').on(t.propertyId, sql`lower(${t.code})`),
    check('room_types_occupancy_ck', sql`${t.standardOccupancy} <= ${t.maxOccupancy}`),
    check('room_types_standard_occupancy_ck', sql`${t.standardOccupancy} >= 1`),
    check('room_types_max_occupancy_ck', sql`${t.maxOccupancy} >= 1`),
    check('room_types_max_children_ck', sql`${t.maxChildren} >= 0`),
  ],
);

/**
 * Physical rooms exist for assignment and housekeeping ONLY. Their count
 * never constrains allotment — that is what makes controlled overselling a
 * business decision rather than a schema limitation (ADR-0002).
 */
export const physicalRooms = pgTable(
  'physical_rooms',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    roomNumber: text('room_number').notNull(),
    floor: text('floor'),
    housekeepingStatus: text('housekeeping_status').notNull().default('CLEAN'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('physical_rooms_property_number_uq').on(t.propertyId, sql`lower(${t.roomNumber})`),
    check(
      'physical_rooms_housekeeping_ck',
      sql`${t.housekeepingStatus} IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER')`,
    ),
  ],
);

export const ratePlans = pgTable(
  'rate_plans',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentRatePlanId: uuid('parent_rate_plan_id').references((): AnyPgColumn => ratePlans.id, {
      onDelete: 'restrict',
    }),
    derivationType: text('derivation_type'),
    /** Basis points when PERCENTAGE, minor units when AMOUNT. */
    derivationValue: integer('derivation_value'),
    mealPlan: text('meal_plan').notNull().default('ROOM_ONLY'),
    cancellationPolicy: jsonb('cancellation_policy')
      .notNull()
      .default(sql`'{}'::jsonb`),
    isRefundable: boolean('is_refundable').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rate_plans_property_code_uq').on(t.propertyId, sql`lower(${t.code})`),
    check(
      'rate_plans_meal_plan_ck',
      sql`${t.mealPlan} IN ('ROOM_ONLY','BREAKFAST','HALF_BOARD','FULL_BOARD','ALL_INCLUSIVE')`,
    ),
    check(
      'rate_plans_derivation_type_ck',
      sql`${t.derivationType} IS NULL OR ${t.derivationType} IN ('PERCENTAGE','AMOUNT')`,
    ),
    // A derived plan needs both derivation fields; a base plan needs neither.
    check(
      'rate_plans_derivation_ck',
      sql`(${t.parentRatePlanId} IS NULL AND ${t.derivationType} IS NULL AND ${t.derivationValue} IS NULL)
          OR (${t.parentRatePlanId} IS NOT NULL AND ${t.derivationType} IS NOT NULL AND ${t.derivationValue} IS NOT NULL)`,
    ),
    check('rate_plans_no_self_parent_ck', sql`${t.parentRatePlanId} <> ${t.id}`),
  ],
);
