import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingRepository,
  type ExpenseRow,
} from '../domain/accounting.repository';

export interface VoidExpenseInput {
  readonly propertyId: string;
  readonly expenseId: string;
  readonly reason: string;
}

/**
 * Reverse an expense that should not have been recorded.
 *
 * Voided, never deleted — the same rule `folio_charges` follows. "This was
 * recorded and then reversed" is a different fact from "this was never
 * recorded", and the difference is precisely what somebody is looking for when
 * a month's costs do not match the bank statement.
 *
 * Voiding also frees the supplier document number, so a bill entered against
 * the wrong vendor can be entered again correctly.
 */
@Injectable()
export class VoidExpenseUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: VoidExpenseInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<ExpenseRow> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const before = await this.repo.findExpense(tx, input.propertyId, input.expenseId);
      if (!before) throw errors.notFound('Expense', input.expenseId);

      const voided = await this.repo.voidExpense(tx, input.propertyId, input.expenseId, {
        userId: actor.type === 'USER' ? actor.id : null,
        reason: input.reason,
        at: now,
      });

      /*
       * False means the UPDATE matched nothing, which after a successful read
       * can only mean it was already void — two people reversing the same
       * mis-keyed bill. Not an error worth a 500, but not a silent success
       * either: the second person needs to know the reason on record is not
       * theirs.
       */
      if (!voided) {
        throw errors.conflict('This expense has already been voided', {
          expenseId: input.expenseId,
          voidedReason: before.voidedReason,
        });
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'expense.voided',
        entityType: 'expense',
        entityId: input.expenseId,
        reason: input.reason,
        before: {
          netAmountMinor: before.netAmountMinor,
          vatMinor: before.vatMinor,
          paidAmountMinor: before.paidAmountMinor,
          description: before.description,
          supplierDocNumber: before.supplierDocNumber,
        },
      });

      const after = await this.repo.findExpense(tx, input.propertyId, input.expenseId);
      /* istanbul ignore next -- it was read at the top of this transaction */
      if (!after) throw errors.notFound('Expense', input.expenseId);
      return after;
    });
  }
}
