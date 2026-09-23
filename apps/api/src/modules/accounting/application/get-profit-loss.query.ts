import { Inject, Injectable } from '@nestjs/common';
import { errors, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { computeBreakdown } from '../../reservations/domain/pricing';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingBasis,
  type AccountingRepository,
} from '../domain/accounting.repository';
import {
  computeProfitLoss,
  type ExpenseLine,
  type ProfitLoss,
  type RevenueLine,
} from '../domain/profit-loss';

/**
 * Profit and loss for a window, on either basis.
 *
 * **Phase 1 derives room revenue live** from the reservation's frozen night
 * prices rather than reading a posted ledger, because no ledger exists yet. The
 * figure is correct for a month nobody has filed on and wrong for one anybody
 * has, which is exactly why phase 2 adds `revenue_postings` and a close.
 *
 * The tax split is `computeBreakdown` — the same function the booking path and
 * the folio use. That is what keeps this report agreeing with the guest's bill;
 * a second derivation of the 10% and the 7% would round differently and there
 * would be no way to say which was right.
 */
@Injectable()
export class GetProfitLossQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
  ) {}

  async execute(
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
    basis: AccountingBasis,
  ): Promise<ProfitLoss> {
    return this.load(this.db, propertyId, from, to, basis);
  }

  async load(
    tx: Executor,
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
    basis: AccountingBasis,
  ): Promise<ProfitLoss> {
    const property = await this.propertyRepo.findProperty(tx, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);

    const currency = property.currency;
    const taxConfig = {
      taxRateBp: property.taxRateBp,
      serviceChargeRateBp: property.serviceChargeRateBp,
      pricesIncludeTax: property.pricesIncludeTax,
    };

    const [derived, otherIncome, expenseRows] = await Promise.all([
      this.repo.derivedRevenue(tx, propertyId, from, to),
      this.repo.listRevenueEntries(tx, propertyId, { from, to, basis, limit: 10_000 }),
      this.repo.listExpenses(tx, propertyId, { from, to, basis, limit: 10_000 }),
    ]);

    const revenue: RevenueLine[] = [];

    /*
     * Rooms and taxable extras are composed together, not side by side. Thai
     * practice is rate → service charge → VAT on the sum, and running two
     * separate compositions rounds each independently — putting the report a
     * baht or two away from the folios it is meant to summarise. The extras'
     * share is recomputed the same way and rooms take the remainder, which is
     * the trick `folio.ts` uses for the same reason.
     */
    const combined = computeBreakdown(
      [
        { amount: derived.roomNetMinor, currency },
        { amount: derived.taxableExtrasNetMinor, currency },
      ],
      currency,
      taxConfig,
    );
    const extrasOnly = computeBreakdown(
      [{ amount: derived.taxableExtrasNetMinor, currency }],
      currency,
      taxConfig,
    );

    revenue.push({
      source: 'ROOM',
      netMinor: combined.subtotal.amount - extrasOnly.subtotal.amount,
      serviceChargeMinor: combined.serviceCharge.amount - extrasOnly.serviceCharge.amount,
      vatMinor: combined.tax.amount - extrasOnly.tax.amount,
    });
    revenue.push({
      source: 'EXTRAS',
      // Untaxed extras carry no service charge and no VAT, so they join the
      // net line directly — a damage recovery is not a sale.
      netMinor: extrasOnly.subtotal.amount + derived.untaxedExtrasMinor,
      serviceChargeMinor: extrasOnly.serviceCharge.amount,
      vatMinor: extrasOnly.tax.amount,
    });

    for (const entry of otherIncome) {
      revenue.push({
        source: 'OTHER',
        netMinor: entry.kind === 'CREDIT_NOTE' ? -entry.netAmountMinor : entry.netAmountMinor,
        serviceChargeMinor: 0,
        vatMinor: entry.kind === 'CREDIT_NOTE' ? -entry.vatMinor : entry.vatMinor,
      });
    }

    const expenses: ExpenseLine[] = expenseRows.map((row) => {
      // A credit note from a supplier reduces the cost; it is stored as its own
      // positive row and turns negative only here, at the point of summing.
      const sign = row.kind === 'VENDOR_CREDIT_NOTE' ? -1 : 1;
      return {
        group: row.categoryGroup,
        categoryId: row.categoryId,
        categoryCode: row.categoryCode,
        categoryNameTh: row.categoryNameTh,
        categoryNameEn: row.categoryNameEn,
        netMinor: sign * row.netAmountMinor,
        vatMinor: sign * row.vatMinor,
        vatClaimable: row.vatClaimable,
        isDeductible: row.categoryIsDeductible,
      };
    });

    return computeProfitLoss(revenue, expenses, currency);
  }
}
