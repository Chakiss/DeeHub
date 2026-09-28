import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { EVENT_TYPES } from '@deehub/shared';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { assertTransition } from '../domain/reservation-status';

export interface ConfirmReservationInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
}

export interface ConfirmReservationResult {
  readonly id: string;
  readonly status: 'CONFIRMED';
  readonly version: number;
}

/**
 * The hotel says yes to a booking that is waiting on it.
 *
 * A booking made on the site without a payment gateway — "pay at the hotel"
 * — is PENDING: it holds its nights, and the guest is told the hotel will
 * confirm. This is that confirmation. It changes status and drops the hold's
 * expiry; inventory does not move, because a PENDING booking already holds
 * its nights (reservation-status.ts, INVENTORY_HOLDING).
 *
 * Not for paid bookings: those are confirmed by the payment landing
 * (settle-payment.usecase), and a desk clicking "confirm" on one would be
 * confirming something already confirmed — the transition table refuses it.
 */
@Injectable()
export class ConfirmReservationUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: ConfirmReservationInput,
    actor: AuditActor,
  ): Promise<ConfirmReservationResult> {
    const tenant = requireTenant();

    const reservation = await this.reservations.findById(this.db, input.reservationId);
    if (!reservation || reservation.propertyId !== input.propertyId) {
      throw errors.notFound('Reservation', input.reservationId);
    }
    assertTransition(reservation.status, 'CONFIRMED');

    return this.db.transaction(async (tx) => {
      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'CONFIRMED',
        { clearHold: true },
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'reservation.confirmed',
        entityType: 'reservation',
        entityId: reservation.id,
        before: { status: reservation.status },
        after: { status: 'CONFIRMED' },
      });

      // The relay turns this into the guest's confirmation email, the same
      // way a payment landing does.
      await this.outbox.record(tx, {
        type: EVENT_TYPES.RESERVATION_STATUS_CHANGED,
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        aggregateType: 'reservation',
        aggregateId: reservation.id,
        payload: {
          reservationId: reservation.id,
          propertyId: input.propertyId,
          code: reservation.code,
          status: 'CONFIRMED',
          channelId: null,
          affectedDates: reservation.stays.flatMap((stay) => stay.nightDates),
        },
      });

      return { id: reservation.id, status: 'CONFIRMED', version: input.expectedVersion + 1 };
    });
  }
}
