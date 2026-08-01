import { Inject, Injectable } from '@nestjs/common';
import { businessDate, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { exceedsRefundable, type FolioPaymentKind, type FolioPaymentMethod } from '../domain/folio';
import { FOLIO_REPOSITORY, type FolioRepository } from '../domain/folio.repository';
import { GetFolioQuery, type Folio } from './get-folio.query';

export interface RecordPaymentInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly kind: FolioPaymentKind;
  readonly method: FolioPaymentMethod;
  readonly amountMinor: number;
  readonly reference: string | null;
}

/**
 * Take money, or give it back.
 *
 * **Overpayment is allowed.** A deposit larger than the bill so far is normal,
 * and so is a guest handing over a round number. Refusing it would send the
 * desk to a notebook, and the balance goes negative, which reads correctly as
 * "the hotel owes this much".
 *
 * **Over-refunding is not.** Giving back more than was ever taken is not a
 * rounding problem — it is a cashier typing into the wrong booking — and it
 * turns a folio into a claim that the hotel owes somebody who has paid nothing.
 *
 * The two directions are separate rows with positive amounts rather than one
 * signed column, because a cashier counting a drawer needs "taken today" and
 * "given back today" apart, and a net figure hides both.
 */
@Injectable()
export class RecordPaymentUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FOLIO_REPOSITORY) private readonly repo: FolioRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly folio: GetFolioQuery,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: RecordPaymentInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<Folio> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const subject = await this.repo.findSubject(tx, input.reservationId);
      if (!subject || subject.propertyId !== input.propertyId) {
        throw errors.notFound('Reservation', input.reservationId);
      }

      const property = await this.propertyRepo.findProperty(tx, input.propertyId);
      if (!property) throw errors.notFound('Property', input.propertyId);

      if (input.kind === 'REFUND') {
        /*
         * Read inside the transaction, and the row lock the insert takes is
         * not enough on its own — two refunds racing could each see the same
         * "paid" figure. Accepted: the window is milliseconds, the operators
         * are two people at one desk, and the alternative is locking every
         * payment row on a booking to record one. The folio shows both, and
         * either can be voided.
         */
        const current = await this.folio.load(tx, input.propertyId, input.reservationId);
        if (exceedsRefundable(input.amountMinor, current.totals)) {
          throw errors.validation('A refund cannot exceed what has been paid on this booking', {
            reservationId: input.reservationId,
            requested: input.amountMinor,
            refundable: current.totals.paid.amount - current.totals.refunded.amount,
          });
        }
      }

      const paymentId = newId();
      await this.repo.insertPayment(tx, {
        id: paymentId,
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        reservationId: input.reservationId,
        kind: input.kind,
        method: input.method,
        amountMinor: input.amountMinor,
        currency: subject.currency,
        reference: input.reference,
        businessDate: businessDate(property.timezone, now),
        // Who took it. The cashier reconciliation is built on this column, so
        // an action by a system actor deliberately records nobody rather than
        // attributing cash to a person who was not there.
        recordedByUserId: actor.type === 'USER' ? actor.id : null,
      });

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: input.kind === 'REFUND' ? 'folio.refunded' : 'folio.payment_recorded',
        entityType: 'reservation',
        entityId: input.reservationId,
        after: {
          paymentId,
          method: input.method,
          amountMinor: input.amountMinor,
          reference: input.reference,
        },
      });

      return this.folio.load(tx, input.propertyId, input.reservationId);
    });
  }
}
