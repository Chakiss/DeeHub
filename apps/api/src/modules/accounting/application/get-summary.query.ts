import { Inject, Injectable } from '@nestjs/common';
import { addDays, errors, isoDate, type IsoDate, type Money } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingBasis,
  type AccountingRepository,
} from '../domain/accounting.repository';
import type { ProfitLoss } from '../domain/profit-loss';
import { GetProfitLossQuery } from './get-profit-loss.query';

export interface MissingRecurringExpense {
  readonly label: string;
  readonly categoryId: string;
  readonly categoryNameTh: string;
  readonly categoryNameEn: string;
  readonly expectedAmountMinor: number | null;
}

export interface AccountingSummary {
  readonly year: number;
  readonly month: number;
  readonly basis: AccountingBasis;
  readonly currency: string;
  readonly revenue: Money;
  readonly expenses: Money;
  readonly netProfit: Money;
  readonly netVatPayable: Money;
  /** The same figures for the month before, so the screen can show a direction. */
  readonly previous: {
    readonly revenue: Money;
    readonly expenses: Money;
    readonly netProfit: Money;
  };
  readonly profitLoss: ProfitLoss;
  /**
   * Bills the property pays every month that have not been entered yet.
   *
   * The completeness half of the report. A wrong expense is visible — it sits
   * in the list looking wrong. A missing one is invisible, and the only symptom
   * is a profit figure that looks better than it is.
   */
  readonly missingRecurring: readonly MissingRecurringExpense[];
}

/**
 * The month, as an owner asks about it.
 *
 * The basis defaults to what the taxpayer actually files on rather than to a
 * constant: an individual files on the cash basis (ภ.ง.ด.90/94) and a company
 * on the accrual basis (ภ.ง.ด.50/51), so the first number they see should be
 * the one they will be taxed on.
 */
@Injectable()
export class GetSummaryQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly profitLoss: GetProfitLossQuery,
  ) {}

  async execute(
    propertyId: string,
    year: number,
    month: number,
    requestedBasis: AccountingBasis | null,
  ): Promise<AccountingSummary> {
    const property = await this.propertyRepo.findProperty(this.db, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);

    const settings = await this.repo.findSettings(this.db, propertyId);
    const basis: AccountingBasis =
      requestedBasis ?? (settings?.taxpayerType === 'JURISTIC' ? 'ACCRUAL' : 'CASH');

    const [from, to] = monthRange(year, month);
    const [previousFrom, previousTo] =
      month === 1 ? monthRange(year - 1, 12) : monthRange(year, month - 1);

    const [current, previous, missingRecurring] = await Promise.all([
      this.profitLoss.load(this.db, propertyId, from, to, basis),
      this.profitLoss.load(this.db, propertyId, previousFrom, previousTo, basis),
      this.findMissingRecurring(propertyId, from, to),
    ]);

    return {
      year,
      month,
      basis,
      currency: property.currency,
      revenue: current.totalRevenue,
      expenses: current.totalExpenses,
      netProfit: current.netProfit,
      netVatPayable: current.netVatPayable,
      previous: {
        revenue: previous.totalRevenue,
        expenses: previous.totalExpenses,
        netProfit: previous.netProfit,
      },
      profitLoss: current,
      missingRecurring,
    };
  }

  /**
   * Recurring bills with no matching expense this month.
   *
   * Matched on category rather than on amount or vendor: the electricity bill
   * is a different number every month and may be paid to a different meter, but
   * it is always electricity. Matching more strictly would nag about bills that
   * are already entered, and a checklist that cries wolf gets ignored.
   *
   * Accrual dates on both sides, whatever basis the report is on — the question
   * is "has this bill been entered", not "has it been paid".
   */
  private async findMissingRecurring(
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<readonly MissingRecurringExpense[]> {
    const [recurrences, entered] = await Promise.all([
      this.repo.listRecurrences(this.db, propertyId),
      this.repo.listExpenses(this.db, propertyId, { from, to, basis: 'ACCRUAL', limit: 10_000 }),
    ]);

    const enteredCategories = new Set(entered.map((expense) => expense.categoryId));
    return recurrences
      .filter((recurrence) => !enteredCategories.has(recurrence.categoryId))
      .map((recurrence) => ({
        label: recurrence.label,
        categoryId: recurrence.categoryId,
        categoryNameTh: recurrence.categoryNameTh,
        categoryNameEn: recurrence.categoryNameEn,
        expectedAmountMinor: recurrence.expectedAmountMinor,
      }));
  }
}

/** `[first of the month, first of the next)` — half-open, like every range here. */
export function monthRange(year: number, month: number): [IsoDate, IsoDate] {
  const from = isoDate(year, month, 1);
  const to = month === 12 ? isoDate(year + 1, 1, 1) : isoDate(year, month + 1, 1);
  // addDays keeps the branded type honest without a second construction path.
  return [from, addDays(to, 0)];
}
