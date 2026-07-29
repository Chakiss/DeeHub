import { sql } from 'drizzle-orm';
import { check, pgTable, timestamp, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './identity';
import { properties } from './property';

/**
 * Role assignment. `propertyId IS NULL` means organization-wide scope.
 * See docs/database.md §3.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLs are distinct in a plain unique index, so org-wide rows need their
    // own partial index or a user could hold several org-wide roles.
    uniqueIndex('memberships_user_property_uq')
      .on(t.userId, t.propertyId)
      .where(sql`${t.propertyId} IS NOT NULL`),
    uniqueIndex('memberships_user_org_wide_uq')
      .on(t.userId)
      .where(sql`${t.propertyId} IS NULL`),
    check(
      'memberships_role_ck',
      sql`${t.role} IN ('OWNER','ADMIN','MANAGER','FRONT_DESK','READ_ONLY')`,
    ),
  ],
);
