import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import {
  RESERVATION_REPOSITORY,
  type BookerFields,
  type ReservationRepository,
} from '../domain/reservation.repository';

export interface UpdateBookerInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
  /** Absent means "leave it alone"; null clears an optional field. */
  readonly bookerName?: string;
  readonly bookerEmail?: string | null;
  readonly bookerPhone?: string | null;
  readonly specialRequests?: string | null;
}

export interface UpdateBookerResult {
  readonly id: string;
  readonly version: number;
  readonly bookerName: string;
  readonly bookerEmail: string | null;
  readonly bookerPhone: string | null;
  readonly specialRequests: string | null;
}

/**
 * Correct who made a booking and how to reach them.
 *
 * A front desk types "เสี่ยวหยู/Wechat" into the name field at 05:49 and
 * learns the guest's real name and phone at breakfast. Until now the only
 * way to fix that was a new reservation, which is a new record, a new code
 * and a new audit trail for the same person.
 *
 * Touches nothing but contact text: no inventory, no money, no status. That
 * is why every status is allowed — fixing the name on a checked-out booking
 * is what an invoice correction looks like. The reservation's own booker
 * fields are what change; the linked guest profile is a separate CRM record
 * with its own endpoint, and the domain model keeps them apart on purpose
 * (docs/domain-model.md: contact "exactly as received" survives).
 */
@Injectable()
export class UpdateBookerUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UpdateBookerInput, actor: AuditActor): Promise<UpdateBookerResult> {
    const tenant = requireTenant();

    const fields: BookerFields = {
      ...(input.bookerName === undefined ? {} : { bookerName: input.bookerName }),
      ...(input.bookerEmail === undefined ? {} : { bookerEmail: input.bookerEmail }),
      ...(input.bookerPhone === undefined ? {} : { bookerPhone: input.bookerPhone }),
      ...(input.specialRequests === undefined ? {} : { specialRequests: input.specialRequests }),
    };
    if (Object.keys(fields).length === 0) throw errors.validation('Nothing to change');

    return this.db.transaction(async (tx) => {
      const before = await this.reservations.findBooker(tx, input.reservationId);
      if (!before || before.propertyId !== input.propertyId) {
        throw errors.notFound('Reservation', input.reservationId);
      }

      const updated = await this.reservations.updateBooker(
        tx,
        input.reservationId,
        input.expectedVersion,
        fields,
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, before.version);
      }

      const after = await this.reservations.findBooker(tx, input.reservationId);
      if (!after) throw errors.notFound('Reservation', input.reservationId);

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'reservation.booker_updated',
        entityType: 'reservation',
        entityId: input.reservationId,
        before: {
          bookerName: before.bookerName,
          bookerEmail: before.bookerEmail,
          bookerPhone: before.bookerPhone,
          specialRequests: before.specialRequests,
        },
        after: {
          bookerName: after.bookerName,
          bookerEmail: after.bookerEmail,
          bookerPhone: after.bookerPhone,
          specialRequests: after.specialRequests,
        },
      });

      return {
        id: after.id,
        version: after.version,
        bookerName: after.bookerName,
        bookerEmail: after.bookerEmail,
        bookerPhone: after.bookerPhone,
        specialRequests: after.specialRequests,
      };
    });
  }
}
