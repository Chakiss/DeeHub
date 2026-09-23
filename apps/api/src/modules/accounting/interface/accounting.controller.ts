import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { errors, isIsoDate, toIsoDate, type IsoDate, type Money } from '@deehub/shared';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { DATABASE, type Database } from '../../../database/database.module';
import { Inject } from '@nestjs/common';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingBasis,
  type AccountingRepository,
  type AccountingSettingsRow,
  type ExpenseRow,
  type RevenueEntryRow,
  type VendorRow,
} from '../domain/accounting.repository';
import { EXPENSE_PAYMENT_METHODS, SUPPLIER_DOC_TYPES } from '../domain/expense';
import { newId } from '../../../common/ids';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { EnsureCategoriesService } from '../application/ensure-categories.service';
import { GetCashBookQuery } from '../application/get-cash-book.query';
import { GetProfitLossQuery } from '../application/get-profit-loss.query';
import { GetSummaryQuery, monthRange } from '../application/get-summary.query';
import { RecordExpenseUseCase } from '../application/record-expense.usecase';
import { RecordRevenueEntryUseCase } from '../application/record-revenue-entry.usecase';
import { SaveSettingsUseCase } from '../application/save-settings.usecase';
import { VoidExpenseUseCase } from '../application/void-expense.usecase';

/** A year at a time, matching the reports module. */
const MAX_RANGE_DAYS = 400;

const amountMinor = z.number().int().positive().max(100_000_000_000);
const basisSchema = z.enum(['CASH', 'ACCRUAL']);
const isoDateString = z.string().refine(isIsoDate, 'Expected a calendar date in YYYY-MM-DD form');

const settingsSchema = z
  .object({
    taxpayerType: z.enum(['INDIVIDUAL', 'JURISTIC']).nullable().optional(),
    taxId: z.string().trim().max(20).nullable().optional(),
    branchCode: z.string().trim().max(5).optional(),
    legalNameTh: z.string().trim().max(200).nullable().optional(),
    legalNameEn: z.string().trim().max(200).nullable().optional(),
    addressTh: z.string().trim().max(500).nullable().optional(),
    vatRegistered: z.boolean().optional(),
    vatRegisteredFrom: isoDateString.nullable().optional(),
    withholdingEnabled: z.boolean().optional(),
    localLevyEnabled: z.boolean().optional(),
    localLevyRateBp: z.number().int().min(0).max(10_000).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  })
  .strict();

const vendorSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    taxId: z.string().trim().max(20).nullable().default(null),
    branchCode: z.string().trim().max(5).nullable().default(null),
    taxpayerType: z.enum(['INDIVIDUAL', 'JURISTIC']).nullable().default(null),
    country: z.string().trim().length(2).default('TH'),
    isForeign: z.boolean().default(false),
    address: z.string().trim().max(500).nullable().default(null),
    phone: z.string().trim().max(50).nullable().default(null),
    email: z.string().trim().max(200).nullable().default(null),
    defaultCategoryId: z.string().uuid().nullable().default(null),
    defaultWhtRateBp: z.number().int().min(0).max(10_000).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

const expenseSchema = z
  .object({
    categoryId: z.string().uuid(),
    vendorId: z.string().uuid().nullable().default(null),
    kind: z.enum(['EXPENSE', 'VENDOR_CREDIT_NOTE']).default('EXPENSE'),
    description: z.string().trim().min(1).max(300),
    amount: amountMinor,
    /** Which end of the bill the amount came from — a receipt total, or a quote. */
    amountIs: z.enum(['GROSS', 'NET']).default('GROSS'),
    vatRateBp: z.number().int().min(0).max(10_000).nullable().default(null),
    vatClaimable: z.boolean().default(true),
    whtRateBp: z.number().int().min(0).max(10_000).default(0),
    selfAssessedVat: z.number().int().min(0).max(100_000_000_000).default(0),
    expenseDate: isoDateString.nullable().default(null),
    paidDate: isoDateString.nullable().default(null),
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).nullable().default(null),
    vatClaimedPeriod: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month in YYYY-MM form')
      .nullable()
      .default(null),
    supplierDocNumber: z.string().trim().max(100).nullable().default(null),
    supplierDocDate: isoDateString.nullable().default(null),
    supplierDocType: z.enum(SUPPLIER_DOC_TYPES).nullable().default(null),
    attachmentRef: z.string().trim().max(300).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

const voidSchema = z.object({ reason: z.string().trim().min(1).max(300) }).strict();

const revenueEntrySchema = z
  .object({
    kind: z.enum(['INCOME', 'CREDIT_NOTE']).default('INCOME'),
    category: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(300),
    payerName: z.string().trim().max(200).nullable().default(null),
    payerTaxId: z.string().trim().max(20).nullable().default(null),
    amount: amountMinor,
    amountIs: z.enum(['GROSS', 'NET']).default('GROSS'),
    vatRateBp: z.number().int().min(0).max(10_000).nullable().default(null),
    whtWithheld: z.number().int().min(0).max(100_000_000_000).default(0),
    incomeDate: isoDateString.nullable().default(null),
    receivedDate: isoDateString.nullable().default(null),
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

type SettingsBody = z.infer<typeof settingsSchema>;
type VendorBody = z.infer<typeof vendorSchema>;
type ExpenseBody = z.infer<typeof expenseSchema>;
type VoidBody = z.infer<typeof voidSchema>;
type RevenueEntryBody = z.infer<typeof revenueEntrySchema>;

@ApiTags('accounting')
@Controller('properties/:propertyId/accounting')
export class AccountingController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly categories: EnsureCategoriesService,
    private readonly saveSettings: SaveSettingsUseCase,
    private readonly recordExpense: RecordExpenseUseCase,
    private readonly voidExpenseUseCase: VoidExpenseUseCase,
    private readonly recordRevenue: RecordRevenueEntryUseCase,
    private readonly summary: GetSummaryQuery,
    private readonly profitLoss: GetProfitLossQuery,
    private readonly cashBook: GetCashBookQuery,
  ) {}

  // ---------------------------------------------------------------- settings

  @Get('settings')
  @RequireCapability('accounting:settings')
  @ApiOperation({ summary: 'Who the hotel is to the Revenue Department' })
  async getSettings(@Param('propertyId') propertyId: string) {
    await this.requireProperty(propertyId);
    const settings = await this.repo.findSettings(this.db, propertyId);
    // Absent settings are not an error: a property exists long before anyone
    // has decided how it is taxed. Report the defaults it would be created with.
    return presentSettings(
      settings ?? {
        propertyId,
        taxpayerType: null,
        taxId: null,
        branchCode: '00000',
        legalNameTh: null,
        legalNameEn: null,
        addressTh: null,
        vatRegistered: false,
        vatRegisteredFrom: null,
        withholdingEnabled: true,
        localLevyEnabled: false,
        localLevyRateBp: 0,
        fiscalYearStartMonth: 1,
      },
    );
  }

  @Put('settings')
  @RequireCapability('accounting:settings')
  @ApiOperation({ summary: 'Record the taxpayer identity and VAT status' })
  async putSettings(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(settingsSchema)) body: SettingsBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return presentSettings(
      await this.saveSettings.execute({ propertyId, ...body }, actorFrom(request)),
    );
  }

  // -------------------------------------------------------------- categories

  @Get('categories')
  @RequireCapability('expense:read')
  @ApiOperation({ summary: 'Expense categories, seeded with Thai hotel defaults' })
  async listCategories(
    @Param('propertyId') propertyId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const items = await this.db.transaction((tx) =>
      this.categories.execute(tx, propertyId, includeInactive === 'true'),
    );
    return { items: items.map((category) => ({ ...category })) };
  }

  // ----------------------------------------------------------------- vendors

  @Get('vendors')
  @RequireCapability('expense:read')
  @ApiOperation({ summary: 'Everyone the hotel pays' })
  async listVendors(
    @Param('propertyId') propertyId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    await this.requireProperty(propertyId);
    const items = await this.repo.listVendors(this.db, propertyId, includeInactive === 'true');
    return { items: items.map(presentVendor) };
  }

  @Post('vendors')
  @RequireCapability('expense:write')
  @ApiOperation({ summary: 'Add a supplier, landlord or agent' })
  async createVendor(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(vendorSchema)) body: VendorBody,
  ) {
    await this.requireProperty(propertyId);
    const id = newId();
    await this.db.transaction((tx) =>
      this.repo.insertVendor(tx, {
        ...body,
        id,
        organizationId: requireOrganizationId(),
        propertyId,
        isActive: true,
      }),
    );
    const saved = await this.repo.findVendor(this.db, propertyId, id);
    /* istanbul ignore next -- just inserted */
    if (!saved) throw errors.notFound('Vendor', id);
    return presentVendor(saved);
  }

  // ---------------------------------------------------------------- expenses

  @Get('expenses')
  @RequireCapability('expense:read')
  @ApiOperation({ summary: 'Expenses in a window, on either basis' })
  async listExpenses(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('basis') basis?: string,
    @Query('categoryId') categoryId?: string,
    @Query('vendorId') vendorId?: string,
    @Query('includeVoided') includeVoided?: string,
  ) {
    await this.requireProperty(propertyId);
    const [start, end] = parseRange(from, to);
    const items = await this.repo.listExpenses(this.db, propertyId, {
      from: start,
      to: end,
      basis: parseBasis(basis),
      categoryId,
      vendorId,
      includeVoided: includeVoided === 'true',
    });
    return { items: items.map(presentExpense) };
  }

  @Post('expenses')
  @RequireCapability('expense:write')
  @ApiOperation({ summary: 'Record a bill, splitting VAT and withholding out of the total' })
  async createExpense(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(expenseSchema)) body: ExpenseBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return presentExpense(
      await this.recordExpense.execute(
        {
          propertyId,
          ...body,
          amountMinor: body.amount,
          selfAssessedVatMinor: body.selfAssessedVat,
        },
        actorFrom(request),
      ),
    );
  }

  @Post('expenses/:expenseId/void')
  @RequireCapability('expense:void')
  @ApiOperation({ summary: 'Reverse an expense, keeping it on the record' })
  async voidExpense(
    @Param('propertyId') propertyId: string,
    @Param('expenseId') expenseId: string,
    @Body(new ZodValidationPipe(voidSchema)) body: VoidBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return presentExpense(
      await this.voidExpenseUseCase.execute(
        { propertyId, expenseId, reason: body.reason },
        actorFrom(request),
      ),
    );
  }

  // ------------------------------------------------------------ other income

  @Get('revenue-entries')
  @RequireCapability('accounting:read')
  @ApiOperation({ summary: 'Income that did not come from a booking' })
  async listRevenueEntries(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('basis') basis?: string,
  ) {
    await this.requireProperty(propertyId);
    const [start, end] = parseRange(from, to);
    const items = await this.repo.listRevenueEntries(this.db, propertyId, {
      from: start,
      to: end,
      basis: parseBasis(basis),
    });
    return { items: items.map(presentRevenueEntry) };
  }

  @Post('revenue-entries')
  @RequireCapability('accounting:read')
  @ApiOperation({ summary: 'Record income from outside the booking system' })
  async createRevenueEntry(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(revenueEntrySchema)) body: RevenueEntryBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return presentRevenueEntry(
      await this.recordRevenue.execute(
        {
          propertyId,
          ...body,
          amountMinor: body.amount,
          whtWithheldMinor: body.whtWithheld,
        },
        actorFrom(request),
      ),
    );
  }

  // ----------------------------------------------------------------- reports

  @Get('summary')
  @RequireCapability('accounting:read')
  @ApiOperation({ summary: 'The month as an owner asks about it' })
  async getSummary(
    @Param('propertyId') propertyId: string,
    @Query('year') year: string,
    @Query('month') month: string,
    @Query('basis') basis?: string,
  ) {
    const [parsedYear, parsedMonth] = parseMonth(year, month);
    const summary = await this.summary.execute(
      propertyId,
      parsedYear,
      parsedMonth,
      basis === undefined || basis === '' ? null : parseBasis(basis),
    );

    return {
      year: summary.year,
      month: summary.month,
      basis: summary.basis,
      currency: summary.currency,
      revenue: presentMoney(summary.revenue),
      expenses: presentMoney(summary.expenses),
      netProfit: presentMoney(summary.netProfit),
      netVatPayable: presentMoney(summary.netVatPayable),
      previous: {
        revenue: presentMoney(summary.previous.revenue),
        expenses: presentMoney(summary.previous.expenses),
        netProfit: presentMoney(summary.previous.netProfit),
      },
      profitLoss: presentProfitLoss(summary.profitLoss),
      missingRecurring: summary.missingRecurring.map((item) => ({ ...item })),
    };
  }

  @Get('reports/profit-loss')
  @RequireCapability('accounting:read')
  @ApiOperation({ summary: 'งบกำไรขาดทุน — revenue less costs, on either basis' })
  async getProfitLoss(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('basis') basis?: string,
  ) {
    const [start, end] = parseRange(from, to);
    return presentProfitLoss(
      await this.profitLoss.execute(propertyId, start, end, parseBasis(basis)),
    );
  }

  @Get('reports/cash-book')
  @RequireCapability('accounting:read')
  @ApiOperation({ summary: 'รายงานเงินสดรับ-จ่าย — money in and out, day by day' })
  async getCashBook(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const [start, end] = parseRange(from, to);
    const book = await this.cashBook.execute(propertyId, start, end);
    return {
      currency: book.currency,
      from: book.from,
      to: book.to,
      openingBalance: presentMoney(book.openingBalance),
      totalReceived: presentMoney(book.totalReceived),
      totalPaid: presentMoney(book.totalPaid),
      closingBalance: presentMoney(book.closingBalance),
      items: book.rows.map((row) => ({
        seq: row.seq,
        date: row.date,
        description: row.description,
        reference: row.reference,
        source: row.source,
        received: presentMoney(row.received),
        paid: presentMoney(row.paid),
        balance: presentMoney(row.balance),
      })),
    };
  }

  /**
   * Confirm the property in the URL belongs to this tenant.
   *
   * An organization-wide membership passes `canAccessProperty` for ANY property
   * id — the guard establishes which tenant is asking, not that the id is
   * theirs. `findProperty` is organization-scoped (ADR-0001), so a foreign id
   * comes back null and becomes a 404, never a 403: a 403 would confirm the
   * property exists.
   *
   * Endpoints whose use case already loads the property do not repeat this.
   */
  private async requireProperty(propertyId: string): Promise<void> {
    const property = await this.propertyRepo.findProperty(this.db, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);
  }
}

/*
 * Explicit shapes throughout. Serializing a row would leak the next column
 * added to the table — and on these tables the next column is as likely to be a
 * tax identity as a display name.
 */

function presentMoney(value: Money) {
  return { amount: value.amount, currency: value.currency };
}

function presentSettings(settings: AccountingSettingsRow) {
  return { ...settings };
}

function presentVendor(vendor: VendorRow) {
  return { ...vendor };
}

function presentExpense(expense: ExpenseRow) {
  return {
    id: expense.id,
    categoryId: expense.categoryId,
    categoryCode: expense.categoryCode,
    categoryNameTh: expense.categoryNameTh,
    categoryNameEn: expense.categoryNameEn,
    categoryGroup: expense.categoryGroup,
    vendorId: expense.vendorId,
    vendorName: expense.vendorName,
    kind: expense.kind,
    description: expense.description,
    currency: expense.currency,
    net: { amount: expense.netAmountMinor, currency: expense.currency },
    vat: { amount: expense.vatMinor, currency: expense.currency },
    selfAssessedVat: { amount: expense.selfAssessedVatMinor, currency: expense.currency },
    gross: { amount: expense.grossAmountMinor, currency: expense.currency },
    wht: { amount: expense.whtMinor, currency: expense.currency },
    paid: { amount: expense.paidAmountMinor, currency: expense.currency },
    vatClaimable: expense.vatClaimable,
    vatClaimedPeriod: expense.vatClaimedPeriod,
    whtRateBp: expense.whtRateBp,
    expenseDate: expense.expenseDate,
    paidDate: expense.paidDate,
    paymentMethod: expense.paymentMethod,
    supplierDocNumber: expense.supplierDocNumber,
    supplierDocDate: expense.supplierDocDate,
    supplierDocType: expense.supplierDocType,
    attachmentRef: expense.attachmentRef,
    note: expense.note,
    recordedBy: expense.recordedBy,
    recordedAt: expense.recordedAt.toISOString(),
    voidedAt: expense.voidedAt?.toISOString() ?? null,
    voidedReason: expense.voidedReason,
  };
}

function presentRevenueEntry(entry: RevenueEntryRow) {
  return {
    id: entry.id,
    kind: entry.kind,
    category: entry.category,
    description: entry.description,
    payerName: entry.payerName,
    payerTaxId: entry.payerTaxId,
    net: { amount: entry.netAmountMinor, currency: entry.currency },
    vat: { amount: entry.vatMinor, currency: entry.currency },
    gross: { amount: entry.grossAmountMinor, currency: entry.currency },
    whtWithheld: { amount: entry.whtWithheldMinor, currency: entry.currency },
    received: { amount: entry.receivedAmountMinor, currency: entry.currency },
    incomeDate: entry.incomeDate,
    receivedDate: entry.receivedDate,
    paymentMethod: entry.paymentMethod,
    note: entry.note,
    recordedAt: entry.recordedAt.toISOString(),
    voidedAt: entry.voidedAt?.toISOString() ?? null,
    voidedReason: entry.voidedReason,
  };
}

function presentProfitLoss(profitLoss: {
  currency: string;
  roomRevenue: Money;
  extrasRevenue: Money;
  otherRevenue: Money;
  serviceCharge: Money;
  totalRevenue: Money;
  expenseGroups: readonly {
    group: string;
    amount: Money;
    categories: readonly {
      categoryId: string;
      categoryCode: string;
      categoryNameTh: string;
      categoryNameEn: string;
      amount: Money;
    }[];
  }[];
  totalExpenses: Money;
  nonDeductibleExpenses: Money;
  netProfit: Money;
  retained: Money;
  outputVat: Money;
  reclaimableInputVat: Money;
  netVatPayable: Money;
}) {
  return {
    currency: profitLoss.currency,
    revenue: {
      room: presentMoney(profitLoss.roomRevenue),
      extras: presentMoney(profitLoss.extrasRevenue),
      other: presentMoney(profitLoss.otherRevenue),
      serviceCharge: presentMoney(profitLoss.serviceCharge),
      total: presentMoney(profitLoss.totalRevenue),
    },
    expenseGroups: profitLoss.expenseGroups.map((group) => ({
      group: group.group,
      total: presentMoney(group.amount),
      categories: group.categories.map((category) => ({
        categoryId: category.categoryId,
        categoryCode: category.categoryCode,
        categoryNameTh: category.categoryNameTh,
        categoryNameEn: category.categoryNameEn,
        amount: presentMoney(category.amount),
      })),
    })),
    totalExpenses: presentMoney(profitLoss.totalExpenses),
    nonDeductibleExpenses: presentMoney(profitLoss.nonDeductibleExpenses),
    netProfit: presentMoney(profitLoss.netProfit),
    retained: presentMoney(profitLoss.retained),
    vat: {
      output: presentMoney(profitLoss.outputVat),
      reclaimableInput: presentMoney(profitLoss.reclaimableInputVat),
      netPayable: presentMoney(profitLoss.netVatPayable),
    },
  };
}

function parseBasis(basis: string | undefined): AccountingBasis {
  if (basis === undefined || basis === '') return 'ACCRUAL';
  const parsed = basisSchema.safeParse(basis);
  if (!parsed.success) throw errors.validation('basis must be CASH or ACCRUAL', { basis });
  return parsed.data;
}

function parseRange(from: string, to: string): [IsoDate, IsoDate] {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw errors.validation('from and to must be calendar dates in YYYY-MM-DD form');
  }
  const start = toIsoDate(from);
  const end = toIsoDate(to);
  if (end <= start) throw errors.validation('Range end must be after start');

  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw errors.validation(`Range cannot exceed ${String(MAX_RANGE_DAYS)} days`);
  }
  return [start, end];
}

function parseMonth(year: string, month: string): [number, number] {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2200) {
    throw errors.validation('year must be a four-digit year', { year });
  }
  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw errors.validation('month must be between 1 and 12', { month });
  }
  // Constructed here so an out-of-range month fails as a validation error
  // rather than as a date-library throw further down.
  monthRange(parsedYear, parsedMonth);
  return [parsedYear, parsedMonth];
}
