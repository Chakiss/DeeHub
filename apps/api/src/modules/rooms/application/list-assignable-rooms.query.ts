import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { physicalRooms, reservationStays, reservations, roomTypes } from '../../../database/schema';

export interface AssignableRoom {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly floor: string | null;
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly housekeepingStatus: string;
}

/**
 * Which rooms could take a guest for these nights.
 *
 * The question the booking form and the assignment dialog both ask. A room
 * qualifies when it is in service, not out of order, and no live booking
 * holds it on any night in `[checkIn, checkOut)` — the same half-open range
 * the exclusion constraint uses, so a room somebody leaves on the arrival
 * morning is offered.
 *
 * This is NOT availability. It says which keys could be handed over, not how
 * many rooms the property is willing to sell (ADR-0002); nothing in inventory
 * reads it, and a hotel with every room assigned may still be selling.
 *
 * The answer is advisory: two desks can be offered the same room and one of
 * them will be refused at the write. That refusal comes from the database,
 * which is the only place the check and the write are atomic.
 */
@Injectable()
export class ListAssignableRoomsQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(
    propertyId: string,
    checkIn: IsoDate,
    checkOut: IsoDate,
  ): Promise<readonly AssignableRoom[]> {
    const organizationId = requireOrganizationId();

    const rows = await this.db
      .select({
        roomId: physicalRooms.id,
        roomNumber: physicalRooms.roomNumber,
        floor: physicalRooms.floor,
        roomTypeId: physicalRooms.roomTypeId,
        roomTypeName: roomTypes.name,
        housekeepingStatus: physicalRooms.housekeepingStatus,
      })
      .from(physicalRooms)
      .innerJoin(roomTypes, eq(roomTypes.id, physicalRooms.roomTypeId))
      .where(
        and(
          eq(physicalRooms.organizationId, organizationId),
          eq(physicalRooms.propertyId, propertyId),
          eq(physicalRooms.isActive, true),
          ne(physicalRooms.housekeepingStatus, 'OUT_OF_ORDER'),
          // Cancelled bookings release their room (cancel-reservation.usecase),
          // but the status check is repeated here so a row the release missed
          // can never hide a free room.
          sql`NOT EXISTS (
            SELECT 1 FROM ${reservationStays}
            INNER JOIN ${reservations} ON ${reservations.id} = ${reservationStays.reservationId}
            WHERE ${reservationStays.assignedRoomId} = ${physicalRooms.id}
              AND ${reservations.status} <> 'CANCELLED'
              AND daterange(${reservationStays.checkIn}, ${reservationStays.checkOut}, '[)')
                  && daterange(${checkIn}::date, ${checkOut}::date, '[)')
          )`,
        ),
      )
      // The corridor order the room list uses: floor, then the numeric part of
      // the number, then the rest.
      .orderBy(
        asc(physicalRooms.floor),
        asc(sql`substring(${physicalRooms.roomNumber} from '^[0-9]+')::bigint`),
        asc(physicalRooms.roomNumber),
      );

    return rows;
  }
}
