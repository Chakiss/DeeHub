import type { IsoDate } from '@deehub/shared';
import type { Executor } from '../../../database/executor';
import type { CashMovement } from './cash-book';
import type { ExpenseGroup, WhtIncomeType } from './expense-category';
import type { ExpenseKind, ExpensePaymentMethod, SupplierDocType } from './expense';

/**
 * Accounting persistence (architecture.md §2 — a port, no Drizzle in sight).
 *
 * Every method takes an `Executor` rather than opening its own transaction: an
 * expense and its audit row have to commit or fail together, and a repository
 * that starts its own transaction makes that impossible to arrange from the
 * use case.
 */

export type TaxpayerType = 'INDIVIDUAL' | 'JURISTIC';

/** Which date a report reads. See ADR-0008 §4 — one row, two date dimensions. */
export type AccountingBasis = 'CASH' | 'ACCRUAL';

export interface AccountingSettingsRow {
  readonly propertyId: string;
  readonly taxpayerType: TaxpayerType | null;
  readonly taxId: string | null;
  readonly branchCode: string;
  readonly legalNameTh: string | null;
  readonly legalNameEn: string | null;
  readonly addressTh: string | null;
  readonly vatRegistered: boolean;
  readonly vatRegisteredFrom: IsoDate | null;
  readonly withholdingEnabled: boolean;
  readonly localLevyEnabled: boolean;
  readonly localLevyRateBp: number;
  readonly fiscalYearStartMonth: number;
}

export type SettingsPatch = Partial<Omit<AccountingSettingsRow, 'propertyId'>>;

export interface ExpenseCategoryRow {
  readonly id: string;
  readonly code: string;
  readonly nameTh: string;
  readonly nameEn: string;
  readonly group: ExpenseGroup;
  readonly defaultWhtRateBp: number;
  readonly defaultWhtIncomeType: WhtIncomeType | null;
  readonly isDeductible: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface NewExpenseCategory extends ExpenseCategoryRow {
  readonly organizationId: string;
  readonly propertyId: string;
}

export interface VendorRow {
  readonly id: string;
  readonly name: string;
  readonly taxId: string | null;
  readonly branchCode: string | null;
  readonly taxpayerType: TaxpayerType | null;
  readonly country: string;
  readonly isForeign: boolean;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly defaultCategoryId: string | null;
  readonly defaultWhtRateBp: number | null;
  readonly note: string | null;
  readonly isActive: boolean;
}

export interface NewVendor extends VendorRow {
  readonly organizationId: string;
  readonly propertyId: string;
}

export interface NewExpense {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly categoryId: string;
  readonly vendorId: string | null;
  readonly kind: ExpenseKind;
  readonly description: string;
  readonly currency: string;
  readonly netAmountMinor: number;
  readonly vatMinor: number;
  readonly selfAssessedVatMinor: number;
  readonly vatClaimable: boolean;
  readonly grossAmountMinor: number;
  readonly whtRateBp: number;
  readonly whtMinor: number;
  readonly paidAmountMinor: number;
  readonly expenseDate: IsoDate;
  readonly paidDate: IsoDate | null;
  readonly paymentMethod: ExpensePaymentMethod | null;
  readonly vatClaimedPeriod: string | null;
  readonly supplierDocNumber: string | null;
  readonly supplierDocDate: IsoDate | null;
  readonly supplierDocType: SupplierDocType | null;
  readonly attachmentRef: string | null;
  readonly note: string | null;
  readonly recordedByUserId: string | null;
}

export interface ExpenseRow extends Omit<NewExpense, 'organizationId' | 'recordedByUserId'> {
  readonly categoryCode: string;
  readonly categoryNameTh: string;
  readonly categoryNameEn: string;
  readonly categoryGroup: ExpenseGroup;
  readonly categoryIsDeductible: boolean;
  readonly vendorName: string | null;
  readonly recordedBy: string | null;
  readonly recordedAt: Date;
  readonly voidedAt: Date | null;
  readonly voidedReason: string | null;
}

export interface ExpenseFilter {
  readonly from: IsoDate;
  /** Exclusive. */
  readonly to: IsoDate;
  readonly basis: AccountingBasis;
  readonly categoryId?: string;
  readonly vendorId?: string;
  /** Voided rows are excluded unless asked for — they are evidence, not data. */
  readonly includeVoided?: boolean;
  readonly limit?: number;
}

export interface NewRevenueEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly kind: 'INCOME' | 'CREDIT_NOTE';
  readonly category: string;
  readonly description: string;
  readonly payerName: string | null;
  readonly payerTaxId: string | null;
  readonly currency: string;
  readonly netAmountMinor: number;
  readonly vatMinor: number;
  readonly grossAmountMinor: number;
  readonly whtWithheldMinor: number;
  readonly receivedAmountMinor: number;
  readonly incomeDate: IsoDate;
  readonly receivedDate: IsoDate | null;
  readonly paymentMethod: ExpensePaymentMethod | null;
  readonly note: string | null;
  readonly recordedByUserId: string | null;
}

export interface RevenueEntryRow extends Omit<
  NewRevenueEntry,
  'organizationId' | 'recordedByUserId'
> {
  readonly recordedAt: Date;
  readonly voidedAt: Date | null;
  readonly voidedReason: string | null;
}

/** Room and extras revenue for a window, straight from the booking side. */
export interface DerivedRevenue {
  /** Frozen night prices from `reservation_stay_nights`, pre-tax. */
  readonly roomNetMinor: number;
  /** Taxable extras from `folio_charges`, pre-tax. */
  readonly taxableExtrasNetMinor: number;
  /** Extras that carry no tax — a damage recovery, a pass-through. */
  readonly untaxedExtrasMinor: number;
}

export interface RecurrenceRow {
  readonly id: string;
  readonly label: string;
  readonly categoryId: string;
  readonly categoryNameTh: string;
  readonly categoryNameEn: string;
  readonly vendorId: string | null;
  readonly dayOfMonth: number;
  readonly expectedAmountMinor: number | null;
  readonly currency: string;
}

export interface NewRecurrence {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly categoryId: string;
  readonly vendorId: string | null;
  readonly label: string;
  readonly dayOfMonth: number;
  readonly expectedAmountMinor: number | null;
  readonly currency: string;
}

export interface VoidedBy {
  readonly userId: string | null;
  readonly reason: string;
  readonly at: Date;
}

export interface AccountingRepository {
  findSettings(tx: Executor, propertyId: string): Promise<AccountingSettingsRow | null>;
  upsertSettings(
    tx: Executor,
    propertyId: string,
    organizationId: string,
    patch: SettingsPatch,
  ): Promise<AccountingSettingsRow>;

  listCategories(
    tx: Executor,
    propertyId: string,
    includeInactive?: boolean,
  ): Promise<readonly ExpenseCategoryRow[]>;
  findCategory(
    tx: Executor,
    propertyId: string,
    categoryId: string,
  ): Promise<ExpenseCategoryRow | null>;
  /** Bulk insert, used once per property to lay down the Thai hotel defaults. */
  insertCategories(tx: Executor, categories: readonly NewExpenseCategory[]): Promise<void>;

  listVendors(
    tx: Executor,
    propertyId: string,
    includeInactive?: boolean,
  ): Promise<readonly VendorRow[]>;
  findVendor(tx: Executor, propertyId: string, vendorId: string): Promise<VendorRow | null>;
  insertVendor(tx: Executor, vendor: NewVendor): Promise<void>;

  insertExpense(tx: Executor, expense: NewExpense): Promise<void>;
  findExpense(tx: Executor, propertyId: string, expenseId: string): Promise<ExpenseRow | null>;
  listExpenses(
    tx: Executor,
    propertyId: string,
    filter: ExpenseFilter,
  ): Promise<readonly ExpenseRow[]>;
  /**
   * Void an expense. False when it is already void or does not exist.
   *
   * Conditional on `voided_at IS NULL` in the WHERE rather than read-then-write,
   * so two people voiding the same mis-keyed bill do not each record a reversal.
   */
  voidExpense(tx: Executor, propertyId: string, expenseId: string, by: VoidedBy): Promise<boolean>;

  /** Active recurring bills, for the month-end completeness check. */
  listRecurrences(tx: Executor, propertyId: string): Promise<readonly RecurrenceRow[]>;
  insertRecurrence(tx: Executor, recurrence: NewRecurrence): Promise<void>;

  insertRevenueEntry(tx: Executor, entry: NewRevenueEntry): Promise<void>;
  findRevenueEntry(
    tx: Executor,
    propertyId: string,
    entryId: string,
  ): Promise<RevenueEntryRow | null>;
  listRevenueEntries(
    tx: Executor,
    propertyId: string,
    filter: Omit<ExpenseFilter, 'categoryId' | 'vendorId'>,
  ): Promise<readonly RevenueEntryRow[]>;

  /**
   * Booking revenue for a window, derived rather than posted.
   *
   * Phase 1 only. Once `revenue_postings` exists (phase 2) the profit and loss
   * reads frozen figures instead, and this becomes the thing the drift check
   * compares them against.
   */
  derivedRevenue(
    tx: Executor,
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<DerivedRevenue>;

  /** Everything that moved money in or out of the property in a window. */
  cashMovements(
    tx: Executor,
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<readonly CashMovement[]>;

  /**
   * Net cash movement strictly before a date.
   *
   * The cash book's opening balance. A book that starts mid-year at zero shows
   * a closing figure that matches no bank account anyone can point at.
   */
  cashBalanceBefore(tx: Executor, propertyId: string, before: IsoDate): Promise<number>;
}

export const ACCOUNTING_REPOSITORY = Symbol('ACCOUNTING_REPOSITORY');
