import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { physicalRooms, reservationStays, reservations } from '../../../database/schema';
import { isExclusionViolation, ROOM_OVERLAP_CONSTRAINT } from '../../../database/postgres-errors';
import { assertRoomAssignable } from '../domain/assignable';
import { findRoomConflict } from '../infrastructure/room-conflict';
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
const ROOM_HOLDING_STATUSES: readonly string[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];

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

    // Only a booking that can still be occupied may hold a room. A cancelled,
    // no-show or expired one has released its rooms, and the exclusion
    // constraint ignores status, so giving it one would block the room.
    if (input.roomId !== null && !ROOM_HOLDING_STATUSES.includes(stay.status)) {
      throw errors.invalidTransition(stay.status, 'ROOM_ASSIGNED');
    }

    let room = null;
    if (input.roomId !== null) {
      room = await this.rooms.findById(this.db, input.propertyId, input.roomId);
      if (!room) throw errors.notFound('Room', input.roomId);

      assertRoomAssignable(room);
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
        const conflict = await findRoomConflict(
          this.db,
          { organizationId, propertyId: input.propertyId },
          input.stayId,
          input.roomId!,
        );
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
}
