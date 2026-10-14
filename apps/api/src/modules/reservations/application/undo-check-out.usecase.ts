import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { EVENT_TYPES, businessDate, errors, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { isExclusionViolation, ROOM_OVERLAP_CONSTRAINT } from '../../../database/postgres-errors';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import {
  physicalRooms,
  reservationStayNights,
  reservationStays,
  reservations as reservationsTable,
} from '../../../database/schema';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { findRoomConflict } from '../../rooms/infrastructure/room-conflict';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { assertTransition, type ReservationStatus } from '../domain/reservation-status';

interface StaySnapshot {
  id: string;
  roomTypeId: string;
  checkOut: string;
  assignedRoomId: string | null;
  roomReleasedOn: string | null;
  nightsReleasedEarly: number;
  roomNumber: string | null;
  housekeepingStatus: string | null;
}

export interface UndoCheckOutInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
  readonly note?: string;
}

export interface UndoCheckOutResult {
  readonly id: string;
  readonly status: 'CHECKED_IN';
  readonly version: number;
  /** Nights taken back from sale because they had been reopened. */
  readonly nightsRestored: readonly IsoDate[];
  /** Rooms the guest is back in that housekeeping still has as dirty. */
  readonly roomsStillDirty: readonly string[];
}

/**
 * Take a booking back from CHECKED_OUT to CHECKED_IN — the check-out button
 * was pressed on the wrong guest, or too soon.
 *
 * It reverses exactly what `check-out.usecase.ts` wrote:
 *
 *   - nights reopened for sale are taken back (`inventory.hold`). If one has
 *     been resold in the meantime the guarded increment comes up short and the
 *     WHOLE transaction rolls back: the desk is told the night is gone, and
 *     nothing is half-undone;
 *   - `room_released_on` is cleared, which re-extends the room's occupied
 *     range. The database's exclusion constraint decides whether someone else
 *     has been put in the room since; this use case only translates its answer;
 *   - housekeeping is deliberately left alone. Check-out marked the room dirty;
 *     the guest is in it again, and it really is not clean.
 *
 * Refused once the booked departure day has passed: by then the room and the
 * nights have moved on, and "undo" would be rewriting history.
 */
@Injectable()
export class UndoCheckOutUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UndoCheckOutInput, actor: AuditActor): Promise<UndoCheckOutResult> {
    const tenant = requireTenant();

    const reservation = await this.reservations.findById(this.db, input.reservationId);
    if (!reservation || reservation.propertyId !== input.propertyId) {
      throw errors.notFound('Reservation', input.reservationId);
    }

    assertTransition(reservation.status as ReservationStatus, 'CHECKED_IN');
    // CHECKED_OUT -> CHECKED_IN is the only edge into CHECKED_IN this use case
    // takes; CONFIRMED -> CHECKED_IN is the check-in endpoint's job.
    if (reservation.status !== 'CHECKED_OUT') {
      throw errors.invalidTransition(reservation.status, 'CHECKED_IN');
    }

    const property = await this.properties.findProperty(this.db, input.propertyId);
    if (!property) throw errors.notFound('Property', input.propertyId);
    const today = businessDate(property.timezone, new Date());

    // Read inside the transaction, after the version check, so a room
    // unassigned between a read and the write cannot slip through.
    let stays: StaySnapshot[] = [];

    try {
      return await this.db.transaction(async (tx) => {
        const updated = await this.reservations.updateStatus(
          tx,
          reservation.id,
          input.expectedVersion,
          'CHECKED_IN',
          { clearCheckedOutAt: true },
        );
        if (updated !== 1) {
          throw errors.versionMismatch(input.expectedVersion, reservation.version);
        }

        stays = await tx
          .select({
            id: reservationStays.id,
            roomTypeId: reservationStays.roomTypeId,
            checkOut: reservationStays.checkOut,
            assignedRoomId: reservationStays.assignedRoomId,
            roomReleasedOn: reservationStays.roomReleasedOn,
            nightsReleasedEarly: reservationStays.nightsReleasedEarly,
            roomNumber: physicalRooms.roomNumber,
            housekeepingStatus: physicalRooms.housekeepingStatus,
          })
          .from(reservationStays)
          .leftJoin(physicalRooms, eq(physicalRooms.id, reservationStays.assignedRoomId))
          .where(
            and(
              eq(reservationStays.organizationId, tenant.organizationId),
              eq(reservationStays.reservationId, input.reservationId),
            ),
          );

        const lastCheckOut = stays
          .map((stay) => stay.checkOut as string)
          .reduce((max, date) => (date > max ? date : max), '');
        if (today > lastCheckOut) {
          throw errors.checkOutUndoTooLate(lastCheckOut, today);
        }

        const [timestamps] = await tx
          .select({ checkedOutAt: reservationsTable.checkedOutAt })
          .from(reservationsTable)
          .where(
            and(
              eq(reservationsTable.organizationId, tenant.organizationId),
              eq(reservationsTable.id, reservation.id),
            ),
          );

        const nightsRestored = await this.restoreNights(
          tx,
          stays,
          tenant.organizationId,
          input.propertyId,
        );

        // Re-extend the occupied range of every room released at check-out.
        // The exclusion constraint fires here if the room was given away.
        const roomsReoccupied: Record<string, string> = {};
        for (const stay of stays) {
          if (stay.roomReleasedOn === null) continue;
          await tx
            .update(reservationStays)
            .set({ roomReleasedOn: null, updatedAt: new Date() })
            .where(
              and(
                eq(reservationStays.organizationId, tenant.organizationId),
                eq(reservationStays.id, stay.id),
              ),
            );
          roomsReoccupied[stay.id] = stay.roomNumber ?? '';
        }

        const roomsStillDirty = stays
          .filter((stay) => stay.housekeepingStatus === 'DIRTY' && stay.roomNumber !== null)
          .map((stay) => stay.roomNumber as string);

        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'reservation.check_out_undone',
          entityType: 'reservation',
          entityId: reservation.id,
          before: {
            status: reservation.status,
            checkedOutAt: timestamps?.checkedOutAt?.toISOString() ?? null,
          },
          after: {
            status: 'CHECKED_IN',
            nightsRestored,
            roomsReoccupied,
            roomsStillDirty,
            note: input.note ?? null,
          },
        });

        return {
          id: reservation.id,
          status: 'CHECKED_IN' as const,
          version: input.expectedVersion + 1,
          nightsRestored,
          roomsStillDirty,
        };
      });
    } catch (error) {
      // The database is the authority on overlap, same as assign-room: another
      // guest was put in the room after this one left.
      if (isExclusionViolation(error, ROOM_OVERLAP_CONSTRAINT)) {
        for (const stay of stays) {
          if (stay.roomReleasedOn === null || stay.assignedRoomId === null) continue;
          const conflict = await findRoomConflict(
            this.db,
            { organizationId: tenant.organizationId, propertyId: input.propertyId },
            stay.id,
            stay.assignedRoomId,
            { asIfNotReleased: true },
          );
          if (conflict) {
            throw errors.conflict(
              `Room ${stay.roomNumber ?? ''} is already taken from ${conflict.checkIn} to ${conflict.checkOut}`.trim(),
              { ...conflict, roomNumber: stay.roomNumber },
            );
          }
        }
        throw errors.conflict('That room is already assigned for overlapping nights');
      }
      throw error;
    }
  }

  /** Take back the nights that check-out reopened for sale. */
  private async restoreNights(
    tx: Executor,
    stays: readonly { id: string; roomTypeId: string; nightsReleasedEarly: number }[],
    organizationId: string,
    propertyId: string,
  ): Promise<readonly IsoDate[]> {
    const restoredAll: IsoDate[] = [];

    for (const stay of stays) {
      const rows = await tx
        .select({ date: reservationStayNights.date })
        .from(reservationStayNights)
        .where(
          and(
            eq(reservationStayNights.organizationId, organizationId),
            eq(reservationStayNights.stayId, stay.id),
            or(
              eq(reservationStayNights.releasedEarly, true),
              isNotNull(reservationStayNights.releasedAt),
            ),
          ),
        )
        .orderBy(reservationStayNights.date);
      const nights = rows.map((row) => row.date as IsoDate);
      if (nights.length === 0 && stay.nightsReleasedEarly === 0) continue;

      if (nights.length > 0) {
        // Same lock order as the booking path.
        const days = await this.inventory.lockDates(tx, stay.roomTypeId, nights);
        const soldOut = nights.filter((date) => {
          const day = days.find((candidate) => candidate.date === date);
          return !day || day.booked + 1 > day.allotment;
        });
        if (soldOut.length > 0) throw errors.inventoryUnavailable(stay.roomTypeId, soldOut);

        const held = await this.inventory.hold(tx, stay.roomTypeId, nights, 1);
        if (held !== nights.length) {
          throw errors.inventoryUnavailable(stay.roomTypeId, nights);
        }

        await tx
          .update(reservationStayNights)
          .set({ releasedEarly: false, releasedAt: null })
          .where(
            and(
              eq(reservationStayNights.organizationId, organizationId),
              eq(reservationStayNights.stayId, stay.id),
              inArray(reservationStayNights.date, nights),
            ),
          );

        await this.outbox.recordMany(tx, [
          {
            type: EVENT_TYPES.INVENTORY_CHANGED,
            organizationId,
            propertyId,
            aggregateType: 'inventory',
            aggregateId: stay.roomTypeId,
            payload: {
              propertyId,
              roomTypeId: stay.roomTypeId,
              from: nights[0] as IsoDate,
              to: nights[nights.length - 1] as IsoDate,
              reason: 'BOOKED_CHANGED' as const,
            },
          },
        ]);
        restoredAll.push(...nights);
      }

      await tx
        .update(reservationStays)
        .set({ nightsReleasedEarly: 0, updatedAt: new Date() })
        .where(
          and(
            eq(reservationStays.organizationId, organizationId),
            eq(reservationStays.id, stay.id),
          ),
        );
    }

    return restoredAll;
  }
}
