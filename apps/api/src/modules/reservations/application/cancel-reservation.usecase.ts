import { Inject, Injectable } from '@nestjs/common';
import { businessDate, errors, EVENT_TYPES, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { assertTransition } from '../domain/reservation-status';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';

export interface CancelReservationInput {
  readonly reservationId: string;
  /** Version the caller last read, for optimistic locking. */
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface CancelReservationResult {
  readonly id: string;
  readonly status: 'CANCELLED';
  /** Nights whose inventory was returned to the pool. */
  readonly releasedNights: readonly IsoDate[];
  /** Nights already consumed, which stay counted in occupancy history. */
  readonly retainedNights: readonly IsoDate[];
}

/**
 * Cancel a reservation and return unconsumed inventory.
 *
 * The subtle rule (domain-model.md §3.5): only nights on or after the
 * property's current BUSINESS DATE are released. Nights the guest already
 * occupied stay counted, otherwise cancelling a stay in progress would
 * retroactively claim the hotel had rooms free on nights it did not.
 */
@Injectable()
export class CancelReservationUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(
    input: CancelReservationInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<CancelReservationResult> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const reservation = await this.reservations.findById(tx, input.reservationId);
      if (!reservation) throw errors.notFound('Reservation', input.reservationId);

      // Domain owns the state machine: cancelling a checked-out or already
      // cancelled reservation is rejected here, not in the UI.
      assertTransition(reservation.status, 'CANCELLED');

      const property = await this.propertyRepo.findProperty(tx, reservation.propertyId);
      if (!property) throw errors.notFound('Property', reservation.propertyId);

      const today = businessDate(property.timezone, now);

      const releasedNights: IsoDate[] = [];
      const retainedNights: IsoDate[] = [];
      const touchedRoomTypes = new Map<string, IsoDate[]>();

      for (const stay of reservation.stays) {
        const releasable = stay.nightDates.filter((night) => night >= today);
        const consumed = stay.nightDates.filter((night) => night < today);
        retainedNights.push(...consumed);

        if (releasable.length === 0) continue;

        // Lock before releasing, in the same date order the booking path uses.
        await this.inventory.lockDates(tx, stay.roomTypeId, releasable);
        const released = await this.inventory.release(tx, stay.roomTypeId, releasable, 1);
        if (released !== releasable.length) {
          // Would mean `booked` is lower than the reservations that reference
          // it — a data-integrity bug. Fail loudly instead of papering over it.
          throw errors.conflict('Inventory release did not match the nights held', {
            reservationId: reservation.id,
            stayId: stay.id,
            expected: releasable.length,
            released,
          });
        }

        releasedNights.push(...releasable);
        const existing = touchedRoomTypes.get(stay.roomTypeId) ?? [];
        touchedRoomTypes.set(stay.roomTypeId, [...existing, ...releasable]);
      }

      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'CANCELLED',
        { cancelledAt: now, cancellationReason: input.reason ?? 'Cancelled' },
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: reservation.propertyId,
        actor,
        action: 'reservation.cancelled',
        entityType: 'reservation',
        entityId: reservation.id,
        before: { status: reservation.status },
        after: {
          status: 'CANCELLED',
          releasedNights,
          retainedNights,
        },
        reason: input.reason ?? null,
      });

      const events: OutboxEventInput[] = [
        {
          type: EVENT_TYPES.RESERVATION_CANCELLED,
          organizationId: tenant.organizationId,
          propertyId: reservation.propertyId,
          aggregateType: 'reservation',
          aggregateId: reservation.id,
          payload: {
            reservationId: reservation.id,
            propertyId: reservation.propertyId,
            code: reservation.code,
            status: 'CANCELLED',
            channelId: null,
            affectedDates: releasedNights,
          },
        },
        ...[...touchedRoomTypes.entries()].map(([roomTypeId, dates]) => {
          const sorted = [...dates].sort();
          const first = sorted[0] as IsoDate;
          const last = sorted[sorted.length - 1] as IsoDate;
          return {
            type: EVENT_TYPES.INVENTORY_CHANGED,
            organizationId: tenant.organizationId,
            propertyId: reservation.propertyId,
            aggregateType: 'inventory',
            aggregateId: roomTypeId,
            payload: {
              propertyId: reservation.propertyId,
              roomTypeId,
              from: first,
              to: last,
              reason: 'BOOKED_CHANGED' as const,
            },
          };
        }),
      ];
      await this.outbox.recordMany(tx, events);

      return {
        id: reservation.id,
        status: 'CANCELLED' as const,
        releasedNights,
        retainedNights,
      };
    });
  }
}
