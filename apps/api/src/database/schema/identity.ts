import { sql } from 'drizzle-orm';
import {
  check,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** See docs/database.md §3. */

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    plan: text('plan').notNull().default('TRIAL'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('organizations_slug_uq').on(sql`lower(${t.slug})`),
    check('organizations_status_ck', sql`${t.status} IN ('ACTIVE','SUSPENDED','CANCELLED')`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Unique per tenant, not globally: the same person may work for two organizations.
    uniqueIndex('users_org_email_uq').on(t.organizationId, sql`lower(${t.email})`),
    check('users_status_ck', sql`${t.status} IN ('ACTIVE','INVITED','DISABLED')`),
  ],
);

/**
 * One-shot credentials for someone who cannot sign in.
 *
 * Hashed at rest for the same reason refresh tokens are: possession of the raw
 * value IS the authentication, so a database leak must not also be a leak of
 * every live reset link.
 *
 * Rows are kept after they are consumed rather than deleted. "This token was
 * already used" and "this token never existed" need different answers during an
 * incident, and a deleted row cannot tell them apart. The maintenance job
 * removes them once they are old enough to be useless as evidence.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The raw token exists only in the email. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set the moment it is spent. A second attempt with the same link fails. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /**
     * Set when a LATER event made this token moot — a successful reset through
     * a different link, or a password change. Distinct from consumed: nobody
     * clicked this one, it just stopped being valid.
     */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    requestedIp: inet('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_hash_uq').on(t.tokenHash),
    // The throttle reads this: live tokens for one user, newest first.
    index('password_reset_tokens_user_live_idx')
      .on(t.userId, t.createdAt.desc())
      .where(sql`${t.consumedAt} IS NULL AND ${t.invalidatedAt} IS NULL`),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Rotation chain: presenting a revoked token means the chain is compromised. */
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => refreshTokens.id),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
