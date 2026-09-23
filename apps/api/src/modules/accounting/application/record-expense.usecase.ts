import { Inject, Injectable } from '@nestjs/common';
import { businessDate, errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { isUniqueViolation } from '../../../database/postgres-errors';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingRepository,
  type ExpenseRow,
} from '../domain/accounting.repository';
import {
  computeExpenseAmounts,
  ExpenseAmountError,
  type ExpenseKind,
  type ExpensePaymentMethod,
  type SupplierDocType,
} from '../domain/expense';
import { EnsureCategoriesService } from './ensure-categories.service';

export interface RecordExpenseInput {
  readonly propertyId: string;
  readonly categoryId: string;
  readonly vendorId: string | null;
  readonly kind: ExpenseKind;
  readonly description: string;
  /** What the owner typed, and which end of the bill it came from. */
  readonly amountMinor: number;
  readonly amountIs: 'GROSS' | 'NET';
  /** Null means "use the property's rate"; zero means "this bill has no VAT". */
  readonly vatRateBp: number | null;
  readonly vatClaimable: boolean;
  readonly whtRateBp: number;
  readonly selfAssessedVatMinor: number;
  readonly expenseDate: string | null;
  readonly paidDate: string | null;
  readonly paymentMethod: ExpensePaymentMethod | null;
  readonly vatClaimedPeriod: string | null;
  readonly supplierDocNumber: string | null;
  readonly supplierDocDate: string | null;
  readonly supplierDocType: SupplierDocType | null;
  readonly attachmentRef: string | null;
  readonly note: string | null;
}

/** Input VAT may be claimed in the invoice's month or the six months after. */
const VAT_CLAIM_WINDOW_MONTHS = 6;

/**
 * Record a bill the hotel has to pay.
 *
 * The arithmetic is in `domain/expense.ts`; this is the part that needs a
 * database, a clock and a tenant. It writes the expense and its audit entry in
 * one transaction, because an expense with no trail is exactly the row somebody
 * will later need to explain.
 */
@Injectable()
export class RecordExpenseUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly categories: EnsureCategoriesService,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: RecordExpenseInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<ExpenseRow> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const property = await this.propertyRepo.findProperty(tx, input.propertyId);
      if (!property) throw errors.notFound('Property', input.propertyId);

      await this.categories.execute(tx, input.propertyId);
      const category = await this.repo.findCategory(tx, input.propertyId, input.categoryId);
      if (!category) throw errors.notFound('Expense category', input.categoryId);

      if (input.vendorId !== null) {
        const vendor = await this.repo.findVendor(tx, input.propertyId, input.vendorId);
        if (!vendor) throw errors.notFound('Vendor', input.vendorId);
      }

      const settings = await this.repo.findSettings(tx, input.propertyId);

      /*
       * A property that is not VAT registered cannot reclaim input tax, so
       * recording any is meaningless at best and an over-claim at worst. The
       * amount stays in the cost where it belongs.
       */
      const registered = settings?.vatRegistered ?? false;
      const vatRateBp = registered ? (input.vatRateBp ?? property.taxRateBp) : 0;

      const expenseDate = this.resolveDate(input.expenseDate, property.timezone, now);
      const paidDate = input.paidDate === null ? null : this.parseDate(input.paidDate, 'paidDate');

      // The schema enforces this too; catching it here says which field is wrong.
      if ((paidDate === null) !== (input.paymentMethod === null)) {
        throw errors.validation(
          'A paid expense needs both a payment date and a method; an unpaid one needs neither',
          { paidDate: input.paidDate, paymentMethod: input.paymentMethod },
        );
      }

      let amounts;
      try {
        amounts = computeExpenseAmounts({
          amountMinor: input.amountMinor,
          amountIs: input.amountIs,
          vatRateBp,
          whtRateBp: input.whtRateBp,
          currency: property.currency,
        });
      } catch (error) {
        if (error instanceof ExpenseAmountError) throw errors.validation(error.message);
        /* istanbul ignore next -- nothing else is thrown from that call */
        throw error;
      }

      const vatClaimedPeriod = this.resolveVatClaimPeriod(
        input.vatClaimedPeriod,
        expenseDate,
        amounts.vat.amount > 0 && input.vatClaimable,
      );

      const expenseId = newId();
      try {
        await this.repo.insertExpense(tx, {
          id: expenseId,
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          categoryId: input.categoryId,
          vendorId: input.vendorId,
          kind: input.kind,
          description: input.description,
          currency: property.currency,
          netAmountMinor: amounts.net.amount,
          vatMinor: amounts.vat.amount,
          selfAssessedVatMinor: input.selfAssessedVatMinor,
          vatClaimable: input.vatClaimable,
          grossAmountMinor: amounts.gross.amount,
          whtRateBp: input.whtRateBp,
          whtMinor: amounts.wht.amount,
          paidAmountMinor: amounts.paid.amount,
          expenseDate,
          paidDate,
          paymentMethod: input.paymentMethod,
          vatClaimedPeriod,
          supplierDocNumber: input.supplierDocNumber,
          supplierDocDate:
            input.supplierDocDate === null
              ? null
              : this.parseDate(input.supplierDocDate, 'supplierDocDate'),
          supplierDocType: input.supplierDocType,
          attachmentRef: input.attachmentRef,
          note: input.note,
          recordedByUserId: actor.type === 'USER' ? actor.id : null,
        });
      } catch (error) {
        /*
         * The duplicate guard is a partial unique index rather than a check
         * before the insert, because two people entering the same electricity
         * bill at the same time would both pass a pre-check and both write.
         * Entering a bill twice doubles a cost, understates profit and
         * over-claims input tax — quiet in all three directions.
         */
        if (isUniqueViolation(error, 'expenses_supplier_doc_uq')) {
          throw errors.conflict('This supplier document has already been recorded', {
            code: 'DUPLICATE_SUPPLIER_DOCUMENT',
            vendorId: input.vendorId,
            supplierDocNumber: input.supplierDocNumber,
          });
        }
        throw error;
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'expense.recorded',
        entityType: 'expense',
        entityId: expenseId,
        after: {
          categoryCode: category.code,
          vendorId: input.vendorId,
          description: input.description,
          netAmountMinor: amounts.net.amount,
          vatMinor: amounts.vat.amount,
          whtMinor: amounts.wht.amount,
          paidAmountMinor: amounts.paid.amount,
          expenseDate,
          paidDate,
          supplierDocNumber: input.supplierDocNumber,
        },
      });

      const saved = await this.repo.findExpense(tx, input.propertyId, expenseId);
      /* istanbul ignore next -- it was just inserted in this transaction */
      if (!saved) throw errors.notFound('Expense', expenseId);
      return saved;
    });
  }

  /** Today in the property's timezone, never the server's (ADR-0003). */
  private resolveDate(value: string | null, timezone: string, now: Date): IsoDate {
    return value === null ? businessDate(timezone, now) : this.parseDate(value, 'expenseDate');
  }

  private parseDate(value: string, field: string): IsoDate {
    if (!isIsoDate(value)) {
      throw errors.validation(`${field} must be a calendar date in YYYY-MM-DD form`, { value });
    }
    return toIsoDate(value);
  }

  /**
   * Which ภ.พ.30 month this input tax is claimed in.
   *
   * Defaults to the invoice's own month, which is what happens when a bill
   * arrives on time. An owner may push it later — a bill found in September for
   * July is normal, not exceptional — but not past the six-month window, and
   * not earlier than the invoice, because claiming tax before it was charged is
   * not a late claim but a wrong one.
   */
  private resolveVatClaimPeriod(
    requested: string | null,
    expenseDate: IsoDate,
    claimable: boolean,
  ): string | null {
    if (!claimable) return null;

    const invoicePeriod = expenseDate.slice(0, 7);
    if (requested === null) return invoicePeriod;

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)) {
      throw errors.validation('vatClaimedPeriod must be a month in YYYY-MM form', { requested });
    }

    const months = monthIndex(requested) - monthIndex(invoicePeriod);
    if (months < 0) {
      throw errors.validation(
        'Input tax cannot be claimed before the month of the supplier invoice',
        { requested, invoicePeriod },
      );
    }
    if (months > VAT_CLAIM_WINDOW_MONTHS) {
      throw errors.validation(
        `Input tax may only be claimed within ${String(VAT_CLAIM_WINDOW_MONTHS)} months of the supplier invoice`,
        { code: 'VAT_CLAIM_WINDOW_EXPIRED', requested, invoicePeriod },
      );
    }
    return requested;
  }
}

/** Months since year zero, so a window can be measured across a year boundary. */
function monthIndex(period: string): number {
  const [year, month] = period.split('-');
  return Number(year) * 12 + Number(month);
}
