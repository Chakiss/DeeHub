import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { FOLIO_REPOSITORY, type FolioRepository } from '../domain/folio.repository';
import { GetFolioQuery, type Folio } from './get-folio.query';

export interface VoidFolioLineInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly lineId: string;
  readonly kind: 'CHARGE' | 'PAYMENT';
  /** Required. A void with no reason is indistinguishable from a mistake. */
  readonly reason: string;
}

/**
 * Reverse a line that should not have been there.
 *
 * Nothing is deleted. A line that vanishes takes the evidence with it, and
 * "this was charged and then reversed" is a different fact from "this was never
 * charged" — which is precisely the difference somebody is looking for when a
 * till does not balance at the end of a shift.
 *
 * Held behind `folio:void` rather than `folio:post`, so a front desk can take
 * money all day and cannot quietly un-take it. That split is the whole point of
 * having two capabilities.
 */
@Injectable()
export class VoidFolioLineUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FOLIO_REPOSITORY) private readonly repo: FolioRepository,
    private readonly folio: GetFolioQuery,
    private readonly audit: AuditService,
  ) {}

  async execute(input: VoidFolioLineInput, actor: AuditActor): Promise<Folio> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const subject = await this.repo.findSubject(tx, input.reservationId);
      if (!subject || subject.propertyId !== input.propertyId) {
        throw errors.notFound('Reservation', input.reservationId);
      }

      const by = {
        userId: actor.type === 'USER' ? actor.id : null,
        reason: input.reason,
        at: new Date(),
      };

      const voided =
        input.kind === 'CHARGE'
          ? await this.repo.voidCharge(tx, input.lineId, input.reservationId, by)
          : await this.repo.voidPayment(tx, input.lineId, input.reservationId, by);

      if (!voided) {
        /*
         * One message for "no such line" and "already void", because the
         * caller's next action is the same either way: refresh and look. The
         * conditional update is also what stops two clerks clicking void on
         * the same mis-keyed payment and each recording a reversal.
         */
        throw errors.conflict('That line is already void, or does not belong to this booking', {
          reservationId: input.reservationId,
          lineId: input.lineId,
        });
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: input.kind === 'CHARGE' ? 'folio.charge_voided' : 'folio.payment_voided',
        entityType: 'reservation',
        entityId: input.reservationId,
        after: { lineId: input.lineId },
        reason: input.reason,
      });

      return this.folio.load(tx, input.propertyId, input.reservationId);
    });
  }
}
