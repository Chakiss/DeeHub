import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './identity';
import { properties } from './property';

/**
 * The hotel's own books — see docs/accounting-plan.md and ADR-0008.
 *
 * Everything the platform stored until now was money coming IN: frozen night
 * prices, folio extras, payments. This is the other half, plus the identity a
 * Thai hotel files its returns under.
 *
 * Two rules from ADR-0008 that the columns here exist to serve, because they
 * are not obvious from the shapes alone:
 *
 * 1. **One fact, one row, two dates.** There is no cash table and no accrual
 *    table. An expense carries the date on the supplier's invoice AND the date
 *    it was actually paid, and a report picks which one it reads. An
 *    individual taxpayer files on the cash basis, a company on the accrual
 *    basis, and both are answerable from the same rows.
 *
 * 2. **VAT is not revenue and not an expense.** Input tax sits in its own
 *    column so it can be reclaimed rather than deducted as a cost, and the
 *    period it is reclaimed IN is its own column too — see `vatClaimedPeriod`.
 */

export const TAXPAYER_TYPES = ['INDIVIDUAL', 'JURISTIC'] as const;

/**
 * Who the hotel is to the Revenue Department.
 *
 * Separate from `properties` because the taxpayer and the building are not the
 * same thing. Several properties under one tax ID are BRANCHES, differing only
 * by `branchCode` — which is why that column is here rather than implied — and
 * a property can be created and sold from long before anyone has decided how
 * it will be taxed.
 */
export const accountingSettings = pgTable(
  'accounting_settings',
  {
    /** One row per property; the property IS the key. */
    propertyId: uuid('property_id')
      .primaryKey()
      .references(() => properties.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * Decides which basis the income-tax reports use, and which forms they
     * support: an individual files ภ.ง.ด.90/94 on the cash basis, a company
     * files ภ.ง.ด.50/51 on the accrual basis. A fact about the taxpayer, not a
     * preference — so it is not a report toggle.
     */
    taxpayerType: text('taxpayer_type'),
    /** 13 digits. Printed on every invoice the business issues, so not a secret. */
    taxId: text('tax_id'),
    /** '00000' is สำนักงานใหญ่ (head office); branches are '00001' upward. */
    branchCode: text('branch_code').notNull().default('00000'),
    legalNameTh: text('legal_name_th'),
    legalNameEn: text('legal_name_en'),
    addressTh: text('address_th'),
    /**
     * Registration is a date, not just a flag: a hotel that crossed the 1.8M
     * THB threshold in June charges VAT from its effective date and not before,
     * and a report covering that month has to know where the line falls.
     */
    vatRegistered: boolean('vat_registered').notNull().default(false),
    vatRegisteredFrom: date('vat_registered_from'),
    withholdingEnabled: boolean('withholding_enabled').notNull().default(true),
    /**
     * ค่าธรรมเนียมบำรุงองค์การบริหารส่วนจังหวัด — collected from the guest and
     * remitted monthly. Off by default and rate-configurable because it is set
     * by each province's own ordinance, so there is no correct constant.
     */
    localLevyEnabled: boolean('local_levy_enabled').notNull().default(false),
    localLevyRateBp: integer('local_levy_rate_bp').notNull().default(0),
    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'accounting_settings_taxpayer_type_ck',
      sql`${t.taxpayerType} IS NULL OR ${t.taxpayerType} IN ('INDIVIDUAL','JURISTIC')`,
    ),
    check('accounting_settings_branch_code_ck', sql`${t.branchCode} ~ '^[0-9]{5}$'`),
    // Length only. The checksum lives in the domain layer, where a rejected ID
    // can explain itself; a constraint violation cannot.
    check('accounting_settings_tax_id_ck', sql`${t.taxId} IS NULL OR ${t.taxId} ~ '^[0-9]{13}$'`),
    check('accounting_settings_levy_rate_ck', sql`${t.localLevyRateBp} BETWEEN 0 AND 10000`),
    check('accounting_settings_fiscal_month_ck', sql`${t.fiscalYearStartMonth} BETWEEN 1 AND 12`),
    // Claiming registration without saying from when leaves every VAT report
    // guessing at the boundary month.
    check(
      'accounting_settings_vat_from_ck',
      sql`${t.vatRegistered} = false OR ${t.vatRegisteredFrom} IS NOT NULL`,
    ),
  ],
);

/** The profit-and-loss line an expense lands on. */
export const EXPENSE_GROUPS = [
  'COGS',
  'PAYROLL',
  'UTILITIES',
  'OPERATIONS',
  'MARKETING',
  'ADMIN',
  'FINANCE',
  'TAX',
  'OTHER',
] as const;

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en').notNull(),
    group: text('group').notNull(),
    /**
     * The withholding rate that normally applies to this kind of spending.
     *
     * This column is the difference between an owner who withholds correctly
     * and one who does not withhold at all. Nobody remembers that maintenance
     * is 3% and rent is 5%; picking "ค่าซ่อมบำรุง" and being offered 3% is
     * something they can check rather than something they must know.
     *
     * A suggestion, never a rule — the rate on the expense is what is filed.
     */
    defaultWhtRateBp: integer('default_wht_rate_bp').notNull().default(0),
    /** Which category of เงินได้ under มาตรา 40 the certificate will cite. */
    defaultWhtIncomeType: text('default_wht_income_type'),
    /** False for spending that is real but not deductible — a fine, an owner's draw. */
    isDeductible: boolean('is_deductible').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('expense_categories_property_code_uq').on(t.propertyId, sql`lower(${t.code})`),
    check(
      'expense_categories_group_ck',
      sql`${t.group} IN ('COGS','PAYROLL','UTILITIES','OPERATIONS','MARKETING','ADMIN','FINANCE','TAX','OTHER')`,
    ),
    check('expense_categories_wht_rate_ck', sql`${t.defaultWhtRateBp} BETWEEN 0 AND 10000`),
    index('expense_categories_property_idx').on(t.propertyId, t.sortOrder),
  ],
);

/** Whoever the hotel pays. A supplier, a landlord, a plumber, an OTA. */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    taxId: text('tax_id'),
    branchCode: text('branch_code'),
    /**
     * Individual or company — and therefore ภ.ง.ด.3 or ภ.ง.ด.53. The two forms
     * are filed separately, so this is not cosmetic: it decides which return a
     * payment appears on.
     */
    taxpayerType: text('taxpayer_type'),
    country: char('country', { length: 2 }).notNull().default('TH'),
    /**
     * Captured in phase 1 although nothing reads it until phase 4.
     *
     * Commission paid to Agoda or Booking.com is a service performed abroad and
     * consumed in Thailand, so a VAT-registered hotel must self-assess 7% VAT
     * on ภ.พ.36. Asking for the flag while the vendor is being created costs a
     * checkbox; reconstructing it later means re-reading two years of invoices.
     */
    isForeign: boolean('is_foreign').notNull().default(false),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    defaultCategoryId: uuid('default_category_id').references(() => expenseCategories.id, {
      onDelete: 'set null',
    }),
    defaultWhtRateBp: integer('default_wht_rate_bp'),
    note: text('note'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendors_property_name_uq').on(t.propertyId, sql`lower(${t.name})`),
    check(
      'vendors_taxpayer_type_ck',
      sql`${t.taxpayerType} IS NULL OR ${t.taxpayerType} IN ('INDIVIDUAL','JURISTIC')`,
    ),
    check('vendors_tax_id_ck', sql`${t.taxId} IS NULL OR ${t.taxId} ~ '^[0-9]{13}$'`),
    check('vendors_branch_code_ck', sql`${t.branchCode} IS NULL OR ${t.branchCode} ~ '^[0-9]{5}$'`),
    check(
      'vendors_wht_rate_ck',
      sql`${t.defaultWhtRateBp} IS NULL OR ${t.defaultWhtRateBp} BETWEEN 0 AND 10000`,
    ),
    // A foreign vendor has no Thai tax ID, and pretending otherwise is how a
    // ภ.พ.36 line ends up filed as an ordinary domestic purchase.
    check('vendors_foreign_tax_id_ck', sql`${t.isForeign} = false OR ${t.taxId} IS NULL`),
    index('vendors_property_active_idx').on(t.propertyId, t.isActive),
  ],
);

export const EXPENSE_KINDS = ['EXPENSE', 'VENDOR_CREDIT_NOTE'] as const;

export const EXPENSE_PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'PROMPTPAY',
  'CARD',
  'CHEQUE',
  'OTHER',
] as const;

export const SUPPLIER_DOC_TYPES = ['TAX_INVOICE', 'RECEIPT', 'INVOICE', 'NONE'] as const;

/** Money going out. */
export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id, { onDelete: 'restrict' }),
    /** Null for petty cash: a market stall issues no document and has no name worth keeping. */
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    /**
     * A vendor's credit note is its own row with a POSITIVE amount, for the
     * reason `folio_payments` gives about refunds: a negative expense nets
     * against the original and the person reconciling needs the two apart.
     */
    kind: text('kind').notNull().default('EXPENSE'),
    description: text('description').notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    /** Before VAT. This is the number that reaches the profit and loss. */
    netAmountMinor: bigint('net_amount_minor', { mode: 'number' }).notNull(),
    /** Input tax the supplier charged. Reclaimed, not deducted — so never a cost. */
    vatMinor: bigint('vat_minor', { mode: 'number' }).notNull().default(0),
    /**
     * VAT the hotel must remit on its own behalf (ภ.พ.36), for a service bought
     * from abroad and used here — OTA commission, almost always.
     *
     * A different tax from `vatMinor` despite the same rate: nobody charged it,
     * the hotel owes it directly, and it becomes claimable input tax only in
     * the month AFTER it is paid. Summing the two would file both wrongly.
     */
    selfAssessedVatMinor: bigint('self_assessed_vat_minor', { mode: 'number' })
      .notNull()
      .default(0),
    /** False when the input tax cannot be reclaimed — entertainment, a non-compliant invoice. */
    vatClaimable: boolean('vat_claimable').notNull().default(true),
    grossAmountMinor: bigint('gross_amount_minor', { mode: 'number' }).notNull(),
    whtRateBp: integer('wht_rate_bp').notNull().default(0),
    whtMinor: bigint('wht_minor', { mode: 'number' }).notNull().default(0),
    /** What the vendor actually receives: gross less anything withheld. */
    paidAmountMinor: bigint('paid_amount_minor', { mode: 'number' }).notNull(),

    /**
     * The accrual date — what the supplier's invoice says.
     *
     * A property-timezone calendar date, like every other business date here
     * (ADR-0003). It is NOT derived from `createdAt`: a bill dated the 30th
     * entered on the 3rd belongs to the month it was issued in.
     */
    expenseDate: date('expense_date').notNull(),
    /** The cash date. Null means unpaid, which is how a payable is represented. */
    paidDate: date('paid_date'),
    paymentMethod: text('payment_method'),

    /**
     * Which ภ.พ.30 month this input tax is actually claimed in.
     *
     * Separate from `expenseDate` because the law allows the invoice's own
     * month or any of the six after it, and an invoice arriving late is the
     * normal case for a small hotel rather than an exception. Without this
     * column a VAT worksheet has nowhere to put a bill that turned up in
     * September for July, and the owner either files it late or not at all.
     */
    vatClaimedPeriod: char('vat_claimed_period', { length: 7 }),

    supplierDocNumber: text('supplier_doc_number'),
    supplierDocDate: date('supplier_doc_date'),
    supplierDocType: text('supplier_doc_type'),

    /**
     * Where the paper is. Free text until object storage exists — "แฟ้ม ก.ค.
     * 69 หน้า 12" is worth more to an owner facing an audit than a null.
     */
    attachmentRef: text('attachment_ref'),
    note: text('note'),

    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedReason: text('voided_reason'),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('expenses_kind_ck', sql`${t.kind} IN ('EXPENSE','VENDOR_CREDIT_NOTE')`),
    check('expenses_gross_positive_ck', sql`${t.grossAmountMinor} > 0`),
    check('expenses_net_nonnegative_ck', sql`${t.netAmountMinor} >= 0`),
    check('expenses_vat_nonnegative_ck', sql`${t.vatMinor} >= 0`),
    check('expenses_self_assessed_vat_ck', sql`${t.selfAssessedVatMinor} >= 0`),
    check('expenses_wht_nonnegative_ck', sql`${t.whtMinor} >= 0`),
    check('expenses_wht_rate_ck', sql`${t.whtRateBp} BETWEEN 0 AND 10000`),
    /*
     * The two identities that make the row internally consistent. Enforced in
     * the database as well as the domain because these numbers are typed by a
     * person under time pressure, and a row that does not add up is one nobody
     * can reconcile later without the original receipt.
     */
    check('expenses_gross_ck', sql`${t.grossAmountMinor} = ${t.netAmountMinor} + ${t.vatMinor}`),
    check('expenses_paid_ck', sql`${t.paidAmountMinor} = ${t.grossAmountMinor} - ${t.whtMinor}`),
    // Withholding cannot exceed the bill it is withheld from.
    check('expenses_wht_bound_ck', sql`${t.whtMinor} <= ${t.grossAmountMinor}`),
    check(
      'expenses_payment_method_ck',
      sql`${t.paymentMethod} IS NULL OR ${t.paymentMethod} IN ('CASH','BANK_TRANSFER','PROMPTPAY','CARD','CHEQUE','OTHER')`,
    ),
    check(
      'expenses_supplier_doc_type_ck',
      sql`${t.supplierDocType} IS NULL OR ${t.supplierDocType} IN ('TAX_INVOICE','RECEIPT','INVOICE','NONE')`,
    ),
    // Paid means paid somehow. A date with no method, or a method with no date,
    // is a half-entered row that the cash report would then have to guess about.
    check('expenses_paid_date_ck', sql`(${t.paidDate} IS NULL) = (${t.paymentMethod} IS NULL)`),
    check('expenses_vat_claimed_period_ck', sql`${t.vatClaimedPeriod} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check('expenses_void_ck', sql`(${t.voidedAt} IS NULL) = (${t.voidedReason} IS NULL)`),

    /*
     * Entering the same supplier invoice twice doubles a cost, understates
     * profit and over-claims input tax — and it happens because two people
     * both "helpfully" enter the bill, or because one person is not sure
     * whether they already did.
     *
     * Voided rows are excluded so a mistake can be corrected and re-entered.
     *
     * `vendorId IS NOT NULL` is in the predicate rather than left implicit
     * because Postgres treats NULLs in a unique index as distinct from each
     * other: without it, two petty-cash rows carrying the same receipt number
     * and no vendor would both be accepted while the index looked like it was
     * guarding them. Stating the boundary is better than an index that appears
     * to cover a case it cannot. A document number without a vendor is a
     * market receipt, where a duplicate costs a few hundred baht — the bill
     * this exists to catch twice is the monthly one from a named supplier.
     */
    uniqueIndex('expenses_supplier_doc_uq')
      .on(t.propertyId, t.vendorId, t.supplierDocNumber)
      .where(
        sql`${t.vendorId} IS NOT NULL AND ${t.supplierDocNumber} IS NOT NULL AND ${t.voidedAt} IS NULL`,
      ),

    index('expenses_property_expense_date_idx').on(t.propertyId, t.expenseDate),
    // The cash book: what left the bank on which day.
    index('expenses_property_paid_date_idx').on(t.propertyId, t.paidDate),
    index('expenses_property_category_idx').on(t.propertyId, t.categoryId, t.expenseDate),
    index('expenses_vendor_idx').on(t.vendorId, t.expenseDate),
    // The VAT worksheet, which reads by claimed period rather than invoice date.
    index('expenses_vat_claimed_idx').on(t.propertyId, t.vatClaimedPeriod),
  ],
);

/**
 * What the hotel spends every month whether or not anyone remembers.
 *
 * A completeness mechanism rather than a convenience one. A wrong expense is
 * visible — it sits in the list looking wrong. A MISSING expense is invisible
 * by construction: nothing prompts anyone to notice a row that is not there,
 * and the profit figure is simply too good. This is what lets the month-end
 * check say "ยังไม่ได้บันทึก: ค่าไฟ".
 */
export const expenseRecurrences = pgTable(
  'expense_recurrences',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    /** Roughly when it usually arrives; used to decide when to start nagging. */
    dayOfMonth: smallint('day_of_month').notNull().default(1),
    /** Optional: a hint on the entry form and a way to flag a surprising bill. */
    expectedAmountMinor: bigint('expected_amount_minor', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 28 rather than 31: a reminder set for the 30th never fires in February.
    check('expense_recurrences_day_ck', sql`${t.dayOfMonth} BETWEEN 1 AND 28`),
    check(
      'expense_recurrences_amount_ck',
      sql`${t.expectedAmountMinor} IS NULL OR ${t.expectedAmountMinor} > 0`,
    ),
    index('expense_recurrences_property_idx').on(t.propertyId, t.isActive),
  ],
);

export const REVENUE_ENTRY_KINDS = ['INCOME', 'CREDIT_NOTE'] as const;

/**
 * Income that did not come from a booking.
 *
 * Shop rent, a laundry service sold to a neighbour, souvenir sales, a
 * cancellation fee billed to a company with no reservation attached. Small
 * amounts individually, and the difference between a profit figure an owner
 * trusts and one they quietly correct in a spreadsheet.
 */
export const revenueEntries = pgTable(
  'revenue_entries',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull().default('INCOME'),
    category: text('category').notNull(),
    description: text('description').notNull(),
    payerName: text('payer_name'),
    payerTaxId: text('payer_tax_id'),
    currency: char('currency', { length: 3 }).notNull(),

    netAmountMinor: bigint('net_amount_minor', { mode: 'number' }).notNull(),
    /** Output tax on this line, when the property is VAT registered. */
    vatMinor: bigint('vat_minor', { mode: 'number' }).notNull().default(0),
    grossAmountMinor: bigint('gross_amount_minor', { mode: 'number' }).notNull(),
    /**
     * Tax a corporate customer withheld from this payment — a credit the hotel
     * can set against its own income tax, not revenue that vanished.
     *
     * Usually zero, and the UI must say why rather than presenting an empty
     * box: under ท.ป.4/2528 hotel accommodation and restaurant service are
     * EXEMPT from the 3% withholding, so a company deducting it from a room
     * bill is doing something the hotel should question. It is legitimately
     * non-zero when a meeting room is let as bare space — that is rent at 5%,
     * as opposed to a seminar package with food and service, which is hotel
     * service and exempt.
     */
    whtWithheldMinor: bigint('wht_withheld_minor', { mode: 'number' }).notNull().default(0),
    receivedAmountMinor: bigint('received_amount_minor', { mode: 'number' }).notNull(),

    /** Accrual: when the income was earned. */
    incomeDate: date('income_date').notNull(),
    /** Cash: when the money arrived. Null while still owed to the hotel. */
    receivedDate: date('received_date'),
    paymentMethod: text('payment_method'),

    note: text('note'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedReason: text('voided_reason'),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('revenue_entries_kind_ck', sql`${t.kind} IN ('INCOME','CREDIT_NOTE')`),
    check('revenue_entries_gross_positive_ck', sql`${t.grossAmountMinor} > 0`),
    check('revenue_entries_net_nonnegative_ck', sql`${t.netAmountMinor} >= 0`),
    check('revenue_entries_vat_nonnegative_ck', sql`${t.vatMinor} >= 0`),
    check('revenue_entries_wht_nonnegative_ck', sql`${t.whtWithheldMinor} >= 0`),
    check(
      'revenue_entries_gross_ck',
      sql`${t.grossAmountMinor} = ${t.netAmountMinor} + ${t.vatMinor}`,
    ),
    check(
      'revenue_entries_received_ck',
      sql`${t.receivedAmountMinor} = ${t.grossAmountMinor} - ${t.whtWithheldMinor}`,
    ),
    check('revenue_entries_wht_bound_ck', sql`${t.whtWithheldMinor} <= ${t.grossAmountMinor}`),
    check(
      'revenue_entries_payment_method_ck',
      sql`${t.paymentMethod} IS NULL OR ${t.paymentMethod} IN ('CASH','BANK_TRANSFER','PROMPTPAY','CARD','CHEQUE','OTHER')`,
    ),
    check(
      'revenue_entries_received_date_ck',
      sql`(${t.receivedDate} IS NULL) = (${t.paymentMethod} IS NULL)`,
    ),
    check(
      'revenue_entries_payer_tax_id_ck',
      sql`${t.payerTaxId} IS NULL OR ${t.payerTaxId} ~ '^[0-9]{13}$'`,
    ),
    check('revenue_entries_void_ck', sql`(${t.voidedAt} IS NULL) = (${t.voidedReason} IS NULL)`),
    index('revenue_entries_property_income_date_idx').on(t.propertyId, t.incomeDate),
    index('revenue_entries_property_received_date_idx').on(t.propertyId, t.receivedDate),
  ],
);
