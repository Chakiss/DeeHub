import { Inject, Injectable } from '@nestjs/common';
import { businessDate, errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
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
  type RevenueEntryRow,
} from '../domain/accounting.repository';
import { addVatToNet, splitVatFromGross, type ExpensePaymentMethod } from '../domain/expense';
import { isValidThaiTaxId, normalizeThaiTaxId } from '../domain/tax-id';

export interface RecordRevenueEntryInput {
  readonly propertyId: string;
  readonly kind: 'INCOME' | 'CREDIT_NOTE';
  readonly category: string;
  readonly description: string;
  readonly payerName: string | null;
  readonly payerTaxId: string | null;
  readonly amountMinor: number;
  readonly amountIs: 'GROSS' | 'NET';
  readonly vatRateBp: number | null;
  /** Tax a corporate customer deducted from the payment. Usually zero — see below. */
  readonly whtWithheldMinor: number;
  readonly incomeDate: string | null;
  readonly receivedDate: string | null;
  readonly paymentMethod: ExpensePaymentMethod | null;
  readonly note: string | null;
}

/**
 * Income that did not come from a booking.
 *
 * Shop rent, laundry sold to a neighbour, a cancellation fee billed to a company
 * with no reservation attached. Individually small, and collectively the
 * difference between a profit figure an owner trusts and one they quietly
 * correct in a spreadsheet.
 */
@Injectable()
export class RecordRevenueEntryUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: RecordRevenueEntryInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<RevenueEntryRow> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const property = await this.propertyRepo.findProperty(tx, input.propertyId);
      if (!property) throw errors.notFound('Property', input.propertyId);

      const settings = await this.repo.findSettings(tx, input.propertyId);
      const vatRateBp = settings?.vatRegistered ? (input.vatRateBp ?? property.taxRateBp) : 0;

      const split =
        input.amountIs === 'GROSS'
          ? splitVatFromGross(input.amountMinor, vatRateBp, property.currency)
          : addVatToNet(input.amountMinor, vatRateBp, property.currency);

      if (input.whtWithheldMinor < 0 || input.whtWithheldMinor > split.gross.amount) {
        throw errors.validation('Withheld tax must be between zero and the amount invoiced', {
          whtWithheldMinor: input.whtWithheldMinor,
          grossAmountMinor: split.gross.amount,
        });
      }

      const payerTaxId = input.payerTaxId === null ? null : normalizeThaiTaxId(input.payerTaxId);
      if (payerTaxId !== null && payerTaxId !== '' && !isValidThaiTaxId(payerTaxId)) {
        throw errors.validation('Payer tax ID must be 13 digits with a valid check digit', {
          payerTaxId,
        });
      }

      const receivedDate =
        input.receivedDate === null ? null : this.parse(input.receivedDate, 'receivedDate');
      if ((receivedDate === null) !== (input.paymentMethod === null)) {
        throw errors.validation(
          'Income that has been received needs both a date and a method; income still owed needs neither',
        );
      }

      const entryId = newId();
      await this.repo.insertRevenueEntry(tx, {
        id: entryId,
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        kind: input.kind,
        category: input.category,
        description: input.description,
        payerName: input.payerName,
        payerTaxId: payerTaxId === '' ? null : payerTaxId,
        currency: property.currency,
        netAmountMinor: split.net.amount,
        vatMinor: split.vat.amount,
        grossAmountMinor: split.gross.amount,
        whtWithheldMinor: input.whtWithheldMinor,
        // What actually arrived. Tax the customer withheld is a credit against
        // the hotel's own income tax, not revenue that never existed.
        receivedAmountMinor: split.gross.amount - input.whtWithheldMinor,
        incomeDate:
          input.incomeDate === null
            ? businessDate(property.timezone, now)
            : this.parse(input.incomeDate, 'incomeDate'),
        receivedDate,
        paymentMethod: input.paymentMethod,
        note: input.note,
        recordedByUserId: actor.type === 'USER' ? actor.id : null,
      });

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'revenue_entry.recorded',
        entityType: 'revenue_entry',
        entityId: entryId,
        after: {
          category: input.category,
          description: input.description,
          netAmountMinor: split.net.amount,
          vatMinor: split.vat.amount,
          whtWithheldMinor: input.whtWithheldMinor,
        },
      });

      const saved = await this.repo.findRevenueEntry(tx, input.propertyId, entryId);
      /* istanbul ignore next -- inserted in this transaction */
      if (!saved) throw errors.notFound('Revenue entry', entryId);
      return saved;
    });
  }

  private parse(value: string, field: string): IsoDate {
    if (!isIsoDate(value)) {
      throw errors.validation(`${field} must be a calendar date in YYYY-MM-DD form`, { value });
    }
    return toIsoDate(value);
  }
}
