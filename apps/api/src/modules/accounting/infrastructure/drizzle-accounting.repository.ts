import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { toIsoDate, type IsoDate } from '@deehub/shared';
import {
  accountingSettings,
  expenseCategories,
  expenseRecurrences,
  expenses,
  folioCharges,
  folioPayments,
  reservationStayNights,
  reservations,
  revenueEntries,
  users,
  vendors,
} from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type { CashMovement } from '../domain/cash-book';
import type {
  AccountingRepository,
  AccountingSettingsRow,
  DerivedRevenue,
  ExpenseCategoryRow,
  ExpenseFilter,
  ExpenseRow,
  NewExpense,
  NewExpenseCategory,
  NewRecurrence,
  NewRevenueEntry,
  NewVendor,
  RecurrenceRow,
  RevenueEntryRow,
  SettingsPatch,
  VendorRow,
  VoidedBy,
} from '../domain/accounting.repository';

/**
 * The statuses that count as sold, matching `get-performance.query.ts`.
 *
 * Deliberately the same set the occupancy report uses. Two definitions of
 * "sold" would let the accounting revenue and the performance revenue disagree
 * for the same month, and nobody would be able to say which one was right.
 */
const SOLD_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const;

/** Bounded so one bad date range cannot try to serialize a decade. */
const DEFAULT_LIST_LIMIT = 500;

@Injectable()
export class DrizzleAccountingRepository implements AccountingRepository {
  // ---------------------------------------------------------------- settings

  async findSettings(tx: Executor, propertyId: string): Promise<AccountingSettingsRow | null> {
    const rows = await tx
      .select()
      .from(accountingSettings)
      .where(
        and(
          eq(accountingSettings.organizationId, requireOrganizationId()),
          eq(accountingSettings.propertyId, propertyId),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? mapSettings(row) : null;
  }

  async upsertSettings(
    tx: Executor,
    propertyId: string,
    organizationId: string,
    patch: SettingsPatch,
  ): Promise<AccountingSettingsRow> {
    const values = {
      propertyId,
      organizationId,
      ...stripUndefined(patch),
      updatedAt: new Date(),
    };

    const [row] = await tx
      .insert(accountingSettings)
      .values(values)
      .onConflictDoUpdate({
        target: accountingSettings.propertyId,
        set: { ...stripUndefined(patch), updatedAt: new Date() },
      })
      .returning();

    /* istanbul ignore next -- an upsert always returns its row */
    if (!row) throw new Error(`Failed to upsert accounting settings for ${propertyId}`);
    return mapSettings(row);
  }

  // -------------------------------------------------------------- categories

  async listCategories(
    tx: Executor,
    propertyId: string,
    includeInactive = false,
  ): Promise<readonly ExpenseCategoryRow[]> {
    const rows = await tx
      .select()
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.organizationId, requireOrganizationId()),
          eq(expenseCategories.propertyId, propertyId),
          includeInactive ? undefined : eq(expenseCategories.isActive, true),
        ),
      )
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.code));

    return rows.map(mapCategory);
  }

  async findCategory(
    tx: Executor,
    propertyId: string,
    categoryId: string,
  ): Promise<ExpenseCategoryRow | null> {
    const rows = await tx
      .select()
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.organizationId, requireOrganizationId()),
          eq(expenseCategories.propertyId, propertyId),
          eq(expenseCategories.id, categoryId),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? mapCategory(row) : null;
  }

  async insertCategories(tx: Executor, categories: readonly NewExpenseCategory[]): Promise<void> {
    if (categories.length === 0) return;
    await tx
      .insert(expenseCategories)
      .values(categories.map((category) => ({ ...category })))
      // Seeding races with itself when two requests arrive for a fresh
      // property at once; the loser should find the categories there, not fail.
      .onConflictDoNothing();
  }

  // ----------------------------------------------------------------- vendors

  async listVendors(
    tx: Executor,
    propertyId: string,
    includeInactive = false,
  ): Promise<readonly VendorRow[]> {
    const rows = await tx
      .select()
      .from(vendors)
      .where(
        and(
          eq(vendors.organizationId, requireOrganizationId()),
          eq(vendors.propertyId, propertyId),
          includeInactive ? undefined : eq(vendors.isActive, true),
        ),
      )
      .orderBy(asc(vendors.name));

    return rows.map(mapVendor);
  }

  async findVendor(tx: Executor, propertyId: string, vendorId: string): Promise<VendorRow | null> {
    const rows = await tx
      .select()
      .from(vendors)
      .where(
        and(
          eq(vendors.organizationId, requireOrganizationId()),
          eq(vendors.propertyId, propertyId),
          eq(vendors.id, vendorId),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? mapVendor(row) : null;
  }

  async insertVendor(tx: Executor, vendor: NewVendor): Promise<void> {
    await tx.insert(vendors).values({ ...vendor });
  }

  // ---------------------------------------------------------------- expenses

  async insertExpense(tx: Executor, expense: NewExpense): Promise<void> {
    await tx.insert(expenses).values({ ...expense });
  }

  async findExpense(
    tx: Executor,
    propertyId: string,
    expenseId: string,
  ): Promise<ExpenseRow | null> {
    const rows = await this.selectExpenses(tx).where(
      and(
        eq(expenses.organizationId, requireOrganizationId()),
        eq(expenses.propertyId, propertyId),
        eq(expenses.id, expenseId),
      ),
    );

    const row = rows[0];
    return row ? mapExpense(row) : null;
  }

  async listExpenses(
    tx: Executor,
    propertyId: string,
    filter: ExpenseFilter,
  ): Promise<readonly ExpenseRow[]> {
    /*
     * Which date column the range applies to IS the cash/accrual choice
     * (ADR-0008 §4). On the cash basis an unpaid bill has no `paid_date` and so
     * falls outside every range, which is correct: it has not cost anything
     * yet.
     */
    const dateColumn = filter.basis === 'CASH' ? expenses.paidDate : expenses.expenseDate;

    const rows = await this.selectExpenses(tx)
      .where(
        and(
          eq(expenses.organizationId, requireOrganizationId()),
          eq(expenses.propertyId, propertyId),
          gte(dateColumn, filter.from),
          lt(dateColumn, filter.to),
          filter.categoryId ? eq(expenses.categoryId, filter.categoryId) : undefined,
          filter.vendorId ? eq(expenses.vendorId, filter.vendorId) : undefined,
          filter.includeVoided ? undefined : isNull(expenses.voidedAt),
        ),
      )
      .orderBy(desc(dateColumn), desc(expenses.recordedAt))
      .limit(filter.limit ?? DEFAULT_LIST_LIMIT);

    return rows.map(mapExpense);
  }

  async voidExpense(
    tx: Executor,
    propertyId: string,
    expenseId: string,
    by: VoidedBy,
  ): Promise<boolean> {
    const result = await tx
      .update(expenses)
      .set({
        voidedAt: by.at,
        voidedReason: by.reason,
        voidedByUserId: by.userId,
        updatedAt: by.at,
      })
      .where(
        and(
          eq(expenses.organizationId, requireOrganizationId()),
          eq(expenses.propertyId, propertyId),
          eq(expenses.id, expenseId),
          // The guard, not a pre-check: two clerks voiding the same row must
          // not each succeed and overwrite the other's reason.
          isNull(expenses.voidedAt),
        ),
      )
      .returning({ id: expenses.id });

    return result.length > 0;
  }

  // ----------------------------------------------------------- other income

  async insertRevenueEntry(tx: Executor, entry: NewRevenueEntry): Promise<void> {
    await tx.insert(revenueEntries).values({ ...entry });
  }

  // ------------------------------------------------------- recurring bills

  async listRecurrences(tx: Executor, propertyId: string): Promise<readonly RecurrenceRow[]> {
    const rows = await tx
      .select({
        id: expenseRecurrences.id,
        label: expenseRecurrences.label,
        categoryId: expenseRecurrences.categoryId,
        categoryNameTh: expenseCategories.nameTh,
        categoryNameEn: expenseCategories.nameEn,
        vendorId: expenseRecurrences.vendorId,
        dayOfMonth: expenseRecurrences.dayOfMonth,
        expectedAmountMinor: expenseRecurrences.expectedAmountMinor,
        currency: expenseRecurrences.currency,
      })
      .from(expenseRecurrences)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenseRecurrences.categoryId))
      .where(
        and(
          eq(expenseRecurrences.organizationId, requireOrganizationId()),
          eq(expenseRecurrences.propertyId, propertyId),
          eq(expenseRecurrences.isActive, true),
        ),
      )
      .orderBy(asc(expenseRecurrences.dayOfMonth), asc(expenseRecurrences.label));

    return rows;
  }

  async insertRecurrence(tx: Executor, recurrence: NewRecurrence): Promise<void> {
    await tx.insert(expenseRecurrences).values({ ...recurrence });
  }

  async findRevenueEntry(
    tx: Executor,
    propertyId: string,
    entryId: string,
  ): Promise<RevenueEntryRow | null> {
    const rows = await tx
      .select()
      .from(revenueEntries)
      .where(
        and(
          eq(revenueEntries.organizationId, requireOrganizationId()),
          eq(revenueEntries.propertyId, propertyId),
          eq(revenueEntries.id, entryId),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? mapRevenueEntry(row) : null;
  }

  async listRevenueEntries(
    tx: Executor,
    propertyId: string,
    filter: Omit<ExpenseFilter, 'categoryId' | 'vendorId'>,
  ): Promise<readonly RevenueEntryRow[]> {
    const dateColumn =
      filter.basis === 'CASH' ? revenueEntries.receivedDate : revenueEntries.incomeDate;

    const rows = await tx
      .select()
      .from(revenueEntries)
      .where(
        and(
          eq(revenueEntries.organizationId, requireOrganizationId()),
          eq(revenueEntries.propertyId, propertyId),
          gte(dateColumn, filter.from),
          lt(dateColumn, filter.to),
          filter.includeVoided ? undefined : isNull(revenueEntries.voidedAt),
        ),
      )
      .orderBy(desc(dateColumn), desc(revenueEntries.recordedAt))
      .limit(filter.limit ?? DEFAULT_LIST_LIMIT);

    return rows.map(mapRevenueEntry);
  }

  // ------------------------------------------------------------ derived side

  async derivedRevenue(
    tx: Executor,
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<DerivedRevenue> {
    const organizationId = requireOrganizationId();

    const roomRows = await tx
      .select({
        // `filter (where not released_early)` matches the occupancy report: a
        // night given back when a guest left early was never sold.
        netMinor: sql<string>`coalesce(sum(${reservationStayNights.amountMinor}) filter (where not ${reservationStayNights.releasedEarly}), 0)`,
      })
      .from(reservationStayNights)
      .innerJoin(reservations, eq(reservations.id, reservationStayNights.reservationId))
      .where(
        and(
          eq(reservationStayNights.organizationId, organizationId),
          eq(reservationStayNights.propertyId, propertyId),
          gte(reservationStayNights.date, from),
          lt(reservationStayNights.date, to),
          inArray(reservations.status, [...SOLD_STATUSES]),
        ),
      );

    const extraRows = await tx
      .select({
        taxable: folioCharges.taxable,
        amountMinor: sql<string>`coalesce(sum(${folioCharges.amountMinor}), 0)`,
      })
      .from(folioCharges)
      .where(
        and(
          eq(folioCharges.organizationId, organizationId),
          eq(folioCharges.propertyId, propertyId),
          gte(folioCharges.businessDate, from),
          lt(folioCharges.businessDate, to),
          isNull(folioCharges.voidedAt),
        ),
      )
      .groupBy(folioCharges.taxable);

    const taxable = extraRows.find((row) => row.taxable);
    const untaxed = extraRows.find((row) => !row.taxable);

    return {
      roomNetMinor: Number(roomRows[0]?.netMinor ?? 0),
      taxableExtrasNetMinor: Number(taxable?.amountMinor ?? 0),
      untaxedExtrasMinor: Number(untaxed?.amountMinor ?? 0),
    };
  }

  // ------------------------------------------------------------------- cash

  async cashMovements(
    tx: Executor,
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<readonly CashMovement[]> {
    const organizationId = requireOrganizationId();

    const payments = await tx
      .select({
        id: folioPayments.id,
        date: folioPayments.businessDate,
        kind: folioPayments.kind,
        method: folioPayments.method,
        amountMinor: folioPayments.amountMinor,
        reference: folioPayments.reference,
        code: reservations.code,
      })
      .from(folioPayments)
      .innerJoin(reservations, eq(reservations.id, folioPayments.reservationId))
      .where(
        and(
          eq(folioPayments.organizationId, organizationId),
          eq(folioPayments.propertyId, propertyId),
          gte(folioPayments.businessDate, from),
          lt(folioPayments.businessDate, to),
          isNull(folioPayments.voidedAt),
        ),
      );

    const income = await tx
      .select({
        id: revenueEntries.id,
        date: revenueEntries.receivedDate,
        description: revenueEntries.description,
        // Net of anything the customer withheld: that part never arrived.
        amountMinor: revenueEntries.receivedAmountMinor,
      })
      .from(revenueEntries)
      .where(
        and(
          eq(revenueEntries.organizationId, organizationId),
          eq(revenueEntries.propertyId, propertyId),
          gte(revenueEntries.receivedDate, from),
          lt(revenueEntries.receivedDate, to),
          isNull(revenueEntries.voidedAt),
        ),
      );

    const paid = await tx
      .select({
        id: expenses.id,
        date: expenses.paidDate,
        description: expenses.description,
        // What the supplier received. Tax withheld has not left yet; it leaves
        // when it is remitted, as its own movement.
        amountMinor: expenses.paidAmountMinor,
        docNumber: expenses.supplierDocNumber,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          eq(expenses.propertyId, propertyId),
          gte(expenses.paidDate, from),
          lt(expenses.paidDate, to),
          isNull(expenses.voidedAt),
        ),
      );

    return [
      ...payments.map((row): CashMovement => {
        const isRefund = row.kind === 'REFUND';
        return {
          date: toIsoDate(row.date),
          direction: isRefund ? 'OUT' : 'IN',
          description: `${isRefund ? 'Refund' : 'Payment'} ${row.code} (${row.method})`,
          amountMinor: row.amountMinor,
          reference: row.reference,
          source: isRefund ? 'FOLIO_REFUND' : 'FOLIO_PAYMENT',
          sourceId: row.id,
        };
      }),
      ...income.map((row): CashMovement => ({
        /* istanbul ignore next -- the query filters received_date NOT NULL */
        date: toIsoDate(row.date ?? ''),
        direction: 'IN',
        description: row.description,
        reference: null,
        amountMinor: row.amountMinor,
        source: 'REVENUE_ENTRY',
        sourceId: row.id,
      })),
      ...paid.map((row): CashMovement => ({
        /* istanbul ignore next -- the query filters paid_date NOT NULL */
        date: toIsoDate(row.date ?? ''),
        direction: 'OUT',
        description: row.description,
        reference: row.docNumber,
        amountMinor: row.amountMinor,
        source: 'EXPENSE',
        sourceId: row.id,
      })),
    ];
  }

  async cashBalanceBefore(tx: Executor, propertyId: string, before: IsoDate): Promise<number> {
    const organizationId = requireOrganizationId();

    const rows = await tx.execute<{ balance: string }>(sql`
      SELECT COALESCE((
        SELECT SUM(CASE WHEN kind = 'REFUND' THEN -amount_minor ELSE amount_minor END)
          FROM folio_payments
         WHERE organization_id = ${organizationId} AND property_id = ${propertyId}
           AND business_date < ${before} AND voided_at IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(received_amount_minor) FROM revenue_entries
         WHERE organization_id = ${organizationId} AND property_id = ${propertyId}
           AND received_date < ${before} AND voided_at IS NULL
      ), 0)
      - COALESCE((
        SELECT SUM(paid_amount_minor) FROM expenses
         WHERE organization_id = ${organizationId} AND property_id = ${propertyId}
           AND paid_date < ${before} AND voided_at IS NULL
      ), 0) AS balance
    `);

    return Number(rows.rows[0]?.balance ?? 0);
  }

  // ----------------------------------------------------------------- helpers

  private selectExpenses(tx: Executor) {
    return tx
      .select({
        expense: expenses,
        categoryCode: expenseCategories.code,
        categoryNameTh: expenseCategories.nameTh,
        categoryNameEn: expenseCategories.nameEn,
        categoryGroup: expenseCategories.group,
        categoryIsDeductible: expenseCategories.isDeductible,
        vendorName: vendors.name,
        recordedBy: users.fullName,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
      .leftJoin(users, eq(users.id, expenses.recordedByUserId))
      .$dynamic();
  }
}

/** Drop keys the caller did not set, so a patch never nulls a column by accident. */
function stripUndefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function mapSettings(row: typeof accountingSettings.$inferSelect): AccountingSettingsRow {
  return {
    propertyId: row.propertyId,
    taxpayerType: row.taxpayerType as AccountingSettingsRow['taxpayerType'],
    taxId: row.taxId,
    branchCode: row.branchCode,
    legalNameTh: row.legalNameTh,
    legalNameEn: row.legalNameEn,
    addressTh: row.addressTh,
    vatRegistered: row.vatRegistered,
    vatRegisteredFrom: row.vatRegisteredFrom ? toIsoDate(row.vatRegisteredFrom) : null,
    withholdingEnabled: row.withholdingEnabled,
    localLevyEnabled: row.localLevyEnabled,
    localLevyRateBp: row.localLevyRateBp,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
  };
}

function mapCategory(row: typeof expenseCategories.$inferSelect): ExpenseCategoryRow {
  return {
    id: row.id,
    code: row.code,
    nameTh: row.nameTh,
    nameEn: row.nameEn,
    group: row.group as ExpenseCategoryRow['group'],
    defaultWhtRateBp: row.defaultWhtRateBp,
    defaultWhtIncomeType: row.defaultWhtIncomeType as ExpenseCategoryRow['defaultWhtIncomeType'],
    isDeductible: row.isDeductible,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

function mapVendor(row: typeof vendors.$inferSelect): VendorRow {
  return {
    id: row.id,
    name: row.name,
    taxId: row.taxId,
    branchCode: row.branchCode,
    taxpayerType: row.taxpayerType as VendorRow['taxpayerType'],
    country: row.country,
    isForeign: row.isForeign,
    address: row.address,
    phone: row.phone,
    email: row.email,
    defaultCategoryId: row.defaultCategoryId,
    defaultWhtRateBp: row.defaultWhtRateBp,
    note: row.note,
    isActive: row.isActive,
  };
}

interface ExpenseJoinRow {
  readonly expense: typeof expenses.$inferSelect;
  readonly categoryCode: string;
  readonly categoryNameTh: string;
  readonly categoryNameEn: string;
  readonly categoryGroup: string;
  readonly categoryIsDeductible: boolean;
  readonly vendorName: string | null;
  readonly recordedBy: string | null;
}

function mapExpense(row: ExpenseJoinRow): ExpenseRow {
  const e = row.expense;
  return {
    id: e.id,
    propertyId: e.propertyId,
    categoryId: e.categoryId,
    vendorId: e.vendorId,
    kind: e.kind as ExpenseRow['kind'],
    description: e.description,
    currency: e.currency,
    netAmountMinor: e.netAmountMinor,
    vatMinor: e.vatMinor,
    selfAssessedVatMinor: e.selfAssessedVatMinor,
    vatClaimable: e.vatClaimable,
    grossAmountMinor: e.grossAmountMinor,
    whtRateBp: e.whtRateBp,
    whtMinor: e.whtMinor,
    paidAmountMinor: e.paidAmountMinor,
    expenseDate: toIsoDate(e.expenseDate),
    paidDate: e.paidDate ? toIsoDate(e.paidDate) : null,
    paymentMethod: e.paymentMethod as ExpenseRow['paymentMethod'],
    vatClaimedPeriod: e.vatClaimedPeriod,
    supplierDocNumber: e.supplierDocNumber,
    supplierDocDate: e.supplierDocDate ? toIsoDate(e.supplierDocDate) : null,
    supplierDocType: e.supplierDocType as ExpenseRow['supplierDocType'],
    attachmentRef: e.attachmentRef,
    note: e.note,
    categoryCode: row.categoryCode,
    categoryNameTh: row.categoryNameTh,
    categoryNameEn: row.categoryNameEn,
    categoryGroup: row.categoryGroup as ExpenseRow['categoryGroup'],
    categoryIsDeductible: row.categoryIsDeductible,
    vendorName: row.vendorName,
    recordedBy: row.recordedBy,
    recordedAt: e.recordedAt,
    voidedAt: e.voidedAt,
    voidedReason: e.voidedReason,
  };
}

function mapRevenueEntry(row: typeof revenueEntries.$inferSelect): RevenueEntryRow {
  return {
    id: row.id,
    propertyId: row.propertyId,
    kind: row.kind as RevenueEntryRow['kind'],
    category: row.category,
    description: row.description,
    payerName: row.payerName,
    payerTaxId: row.payerTaxId,
    currency: row.currency,
    netAmountMinor: row.netAmountMinor,
    vatMinor: row.vatMinor,
    grossAmountMinor: row.grossAmountMinor,
    whtWithheldMinor: row.whtWithheldMinor,
    receivedAmountMinor: row.receivedAmountMinor,
    incomeDate: toIsoDate(row.incomeDate),
    receivedDate: row.receivedDate ? toIsoDate(row.receivedDate) : null,
    paymentMethod: row.paymentMethod as RevenueEntryRow['paymentMethod'],
    note: row.note,
    recordedAt: row.recordedAt,
    voidedAt: row.voidedAt,
    voidedReason: row.voidedReason,
  };
}
