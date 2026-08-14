import { Module } from '@nestjs/common';
import { PropertiesModule } from '../properties/properties.module';
import { EnsureCategoriesService } from './application/ensure-categories.service';
import { GetCashBookQuery } from './application/get-cash-book.query';
import { GetProfitLossQuery } from './application/get-profit-loss.query';
import { GetSummaryQuery } from './application/get-summary.query';
import { RecordExpenseUseCase } from './application/record-expense.usecase';
import { RecordRevenueEntryUseCase } from './application/record-revenue-entry.usecase';
import { SaveSettingsUseCase } from './application/save-settings.usecase';
import { VoidExpenseUseCase } from './application/void-expense.usecase';
import { ACCOUNTING_REPOSITORY } from './domain/accounting.repository';
import { DrizzleAccountingRepository } from './infrastructure/drizzle-accounting.repository';
import { AccountingController } from './interface/accounting.controller';

/**
 * The hotel's own books (ADR-0008).
 *
 * Owns expenses, vendors, categories, other income and the taxpayer identity.
 * It does NOT own revenue: room and extras figures are read from the booking
 * side through `derivedRevenue`, so this module cannot disagree with a folio
 * about what a night cost.
 *
 * That changes in phase 2, when `revenue_postings` freezes each business date
 * and this module gains a number of its own — at which point it also gains the
 * reconciler that is the price of having one.
 */
@Module({
  imports: [PropertiesModule],
  controllers: [AccountingController],
  providers: [
    { provide: ACCOUNTING_REPOSITORY, useClass: DrizzleAccountingRepository },
    EnsureCategoriesService,
    SaveSettingsUseCase,
    RecordExpenseUseCase,
    VoidExpenseUseCase,
    RecordRevenueEntryUseCase,
    GetSummaryQuery,
    GetProfitLossQuery,
    GetCashBookQuery,
  ],
  exports: [ACCOUNTING_REPOSITORY, GetProfitLossQuery],
})
export class AccountingModule {}
