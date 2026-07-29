import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './identity';

/** Envelope-encrypted payload (Cloud KMS). Never searchable, never logged. */
export const encryptedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** See docs/database.md §7. */
export const guests = pgTable(
  'guests',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    nationality: char('nationality', { length: 2 }),
    documentType: text('document_type'),
    documentNumberEncrypted: encryptedBytes('document_number_encrypted'),
    dateOfBirth: date('date_of_birth'),
    preferences: jsonb('preferences')
      .notNull()
      .default(sql`'{}'::jsonb`),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Deliberately NOT unique on email: OTAs supply masked and aliased
    // addresses, so duplicates are expected and merged later (Phase 4).
    index('guests_org_email_idx').on(t.organizationId, sql`lower(${t.email})`),
    index('guests_org_phone_idx').on(t.organizationId, t.phone),
    index('guests_org_name_idx').on(
      t.organizationId,
      sql`lower(${t.lastName})`,
      sql`lower(${t.firstName})`,
    ),
    check(
      'guests_document_type_ck',
      sql`${t.documentType} IS NULL OR ${t.documentType} IN ('PASSPORT','NATIONAL_ID','DRIVING_LICENSE')`,
    ),
  ],
);
