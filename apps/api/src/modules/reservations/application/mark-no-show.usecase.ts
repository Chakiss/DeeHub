import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { businessDate, errors, EVENT_TYPES, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { reservationStayNights, reservationStays } from '../../../database/schema';
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

export interface MarkNoShowInput {
  readonly propertyId: string;
  readonly reservationId: string;
  /** Version the caller last read, for optimistic locking. */
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface MarkNoShowResult {
  readonly id: string;
  readonly status: 'NO_SHOW';
  /** Nights whose inventory was returned to the pool. */
  readonly releasedNights: readonly IsoDate[];
  /** Nights before today, which stay counted in occupancy history. */
  readonly retainedNights: readonly IsoDate[];
}

/**
 * The guest never arrived (business date is past the check-in date): close a CONFIRMED booking as NO_SHOW.
 *
 * Mirrors cancel's night handling (only nights on or after the property's
 * business date go back on sale, rooms are unassigned) but never touches the
 * folio: a no-show refunds nothing (business-rules.md "No-show").
 */
@Injectable()
export class MarkNoShowUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(
    input: MarkNoShowInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<MarkNoShowResult> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const reservation = await this.reservations.findById(tx, input.reservationId, {
        forUpdate: true,
      });
      // Another property's booking is indistinguishable from a missing one.
      if (!reservation || reservation.propertyId !== input.propertyId) {
        throw errors.notFound('Reservation', input.reservationId);
      }

      // Only CONFIRMED may become NO_SHOW: a PENDING hold expires instead.
      assertTransition(reservation.status, 'NO_SHOW');

      const property = await this.propertyRepo.findProperty(tx, reservation.propertyId);
      if (!property) throw errors.notFound('Property', reservation.propertyId);

      const today = businessDate(property.timezone, now);
      const checkIn = reservation.stays.map((stay) => stay.checkIn).sort()[0] as IsoDate;
      // Strictly after: a guest on a late flight still needs the room on arrival
      // day. The desk can cancel instead if it truly wants tonight back.
      if (today <= checkIn) throw errors.noShowTooEarly(checkIn, today);

      const releasedNights: IsoDate[] = [];
      const retainedNights: IsoDate[] = [];
      const touchedRoomTypes = new Map<string, IsoDate[]>();

      // Same order everywhere, so two multi-room bookings cannot lock against each other.
      const staysByRoomType = [...reservation.stays].sort((a, b) =>
        a.roomTypeId.localeCompare(b.roomTypeId),
      );

      for (const stay of staysByRoomType) {
        const releasable = stay.nightDates.filter((night) => night >= today);
        retainedNights.push(...stay.nightDates.filter((night) => night < today));
        if (releasable.length === 0) continue;

        // Lock before releasing, in the same date order the booking path uses.
        await this.inventory.lockDates(tx, stay.roomTypeId, releasable);
        const released = await this.inventory.release(tx, stay.roomTypeId, releasable, 1);
        if (released !== releasable.length) {
          throw errors.conflict('Inventory release did not match the nights held', {
            reservationId: reservation.id,
            stayId: stay.id,
            expected: releasable.length,
            released,
          });
        }

        await tx
          .update(reservationStayNights)
          .set({ releasedAt: now })
          .where(
            and(
              eq(reservationStayNights.organizationId, tenant.organizationId),
              eq(reservationStayNights.stayId, stay.id),
              inArray(reservationStayNights.date, releasable),
            ),
          );

        releasedNights.push(...releasable);
        touchedRoomTypes.set(stay.roomTypeId, [
          ...(touchedRoomTypes.get(stay.roomTypeId) ?? []),
          ...releasable,
        ]);
      }

      // The exclusion constraint on room assignment ignores status, so a
      // no-show must give its room back or block it for those nights forever.
      const releasedRooms = await tx
        .update(reservationStays)
        .set({ assignedRoomId: null, updatedAt: now })
        .where(
          and(
            eq(reservationStays.organizationId, tenant.organizationId),
            eq(reservationStays.reservationId, reservation.id),
            isNotNull(reservationStays.assignedRoomId),
          ),
        );

      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'NO_SHOW',
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: reservation.propertyId,
        actor,
        action: 'reservation.no_show',
        entityType: 'reservation',
        entityId: reservation.id,
        before: { status: reservation.status },
        after: {
          status: 'NO_SHOW',
          releasedNights,
          retainedNights,
          roomsReleased: releasedRooms.rowCount ?? 0,
        },
        reason: input.reason ?? null,
      });

      const events: OutboxEventInput[] = [
        {
          type: EVENT_TYPES.RESERVATION_NO_SHOW,
          organizationId: tenant.organizationId,
          propertyId: reservation.propertyId,
          aggregateType: 'reservation',
          aggregateId: reservation.id,
          payload: {
            reservationId: reservation.id,
            propertyId: reservation.propertyId,
            code: reservation.code,
            status: 'NO_SHOW',
            channelId: null,
            affectedDates: releasedNights,
          },
        },
        ...[...touchedRoomTypes.entries()].map(([roomTypeId, dates]) => {
          const sorted = [...dates].sort();
          return {
            type: EVENT_TYPES.INVENTORY_CHANGED,
            organizationId: tenant.organizationId,
            propertyId: reservation.propertyId,
            aggregateType: 'inventory',
            aggregateId: roomTypeId,
            payload: {
              propertyId: reservation.propertyId,
              roomTypeId,
              from: sorted[0] as IsoDate,
              to: sorted[sorted.length - 1] as IsoDate,
              reason: 'BOOKED_CHANGED' as const,
            },
          };
        }),
      ];
      await this.outbox.recordMany(tx, events);

      return {
        id: reservation.id,
        status: 'NO_SHOW' as const,
        releasedNights,
        retainedNights,
      };
    });
  }
}
