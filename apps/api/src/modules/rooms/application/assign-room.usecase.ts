import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { physicalRooms, reservationStays, reservations } from '../../../database/schema';
import { isExclusionViolation, ROOM_OVERLAP_CONSTRAINT } from '../../../database/postgres-errors';
import { ROOM_REPOSITORY, type RoomRepository } from '../domain/room.repository';

export interface AssignRoomInput {
  readonly propertyId: string;
  readonly stayId: string;
  /** null releases the room without assigning another. */
  readonly roomId: string | null;
}

/**
 * Put a booking in a room, or take it out of one.
 *
 * Assignment never touches availability. A room is a place to sleep; allotment
 * is what the property decided to sell (ADR-0002). Assigning every room in the
 * hotel changes no number an OTA sees.
 */
@Injectable()
export class AssignRoomUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ROOM_REPOSITORY) private readonly rooms: RoomRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: AssignRoomInput,
    actor: AuditActor,
  ): Promise<{ assignedRoomId: string | null }> {
    const organizationId = requireOrganizationId();

    const stay = await this.findStay(input.propertyId, input.stayId);
    if (!stay) throw errors.notFound('Stay', input.stayId);

    // A cancelled booking has no business holding a room someone else could use.
    if (stay.status === 'CANCELLED' && input.roomId !== null) {
      throw errors.validation('This reservation is cancelled and cannot be given a room');
    }

    let room = null;
    if (input.roomId !== null) {
      room = await this.rooms.findById(this.db, input.propertyId, input.roomId);
      if (!room) throw errors.notFound('Room', input.roomId);

      if (!room.isActive) {
        throw errors.validation(`Room ${room.roomNumber} is not in service`);
      }
      if (room.housekeepingStatus === 'OUT_OF_ORDER') {
        throw errors.validation(`Room ${room.roomNumber} is out of order`);
      }
      // Cross-type assignment is allowed on purpose — an upgrade is a normal
      // front-desk decision — but it is worth recording, so the audit entry
      // below carries both types.
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(reservationStays)
          .set({ assignedRoomId: input.roomId, updatedAt: new Date() })
          .where(
            and(
              eq(reservationStays.organizationId, organizationId),
              eq(reservationStays.propertyId, input.propertyId),
              eq(reservationStays.id, input.stayId),
            ),
          );

        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          action: input.roomId === null ? 'stay.room_released' : 'stay.room_assigned',
          entityType: 'reservation_stay',
          entityId: input.stayId,
          before: { assignedRoomId: stay.assignedRoomId },
          after: {
            assignedRoomId: input.roomId,
            ...(room
              ? {
                  roomNumber: room.roomNumber,
                  upgraded: room.roomTypeId !== stay.roomTypeId,
                }
              : {}),
          },
        });
      });
    } catch (error) {
      // The database is the authority on overlap: checking first and writing
      // after cannot be made atomic against a concurrent assignment without
      // locking the room. Translate its refusal into something a front desk can
      // act on rather than a 500.
      if (isExclusionViolation(error, ROOM_OVERLAP_CONSTRAINT)) {
        const conflict = await this.findConflict(input.propertyId, input.stayId, input.roomId!);
        throw errors.conflict(
          conflict
            ? `Room ${room?.roomNumber ?? ''} is already taken from ${conflict.checkIn} to ${conflict.checkOut}`.trim()
            : 'That room is already assigned for overlapping nights',
          conflict ?? undefined,
        );
      }
      throw error;
    }

    return { assignedRoomId: input.roomId };
  }

  private async findStay(propertyId: string, stayId: string) {
    const rows = await this.db
      .select({
        id: reservationStays.id,
        roomTypeId: reservationStays.roomTypeId,
        assignedRoomId: reservationStays.assignedRoomId,
        status: reservations.status,
      })
      .from(reservationStays)
      .innerJoin(reservations, eq(reservations.id, reservationStays.reservationId))
      .where(
        and(
          eq(reservationStays.organizationId, requireOrganizationId()),
          eq(reservationStays.propertyId, propertyId),
          eq(reservationStays.id, stayId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /** Which booking already holds the room, so the message can say so. */
  private async findConflict(propertyId: string, stayId: string, roomId: string) {
    const rows = await this.db
      .select({
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
        reservationCode: reservations.code,
      })
      .from(reservationStays)
      .innerJoin(reservations, eq(reservations.id, reservationStays.reservationId))
      .where(
        and(
          eq(reservationStays.organizationId, requireOrganizationId()),
          eq(reservationStays.propertyId, propertyId),
          eq(reservationStays.assignedRoomId, roomId),
          ne(reservationStays.id, stayId),
          sql`daterange(${reservationStays.checkIn}, ${reservationStays.checkOut}, '[)') && (
            SELECT daterange(check_in, check_out, '[)') FROM reservation_stays WHERE id = ${stayId}
          )`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }
}
