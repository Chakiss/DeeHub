import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { dateRange, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { physicalRooms, reservationStays, reservations, roomTypes } from '../../../database/schema';

export interface StayViewOccupancy {
  readonly stayId: string;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly guestName: string | null;
  readonly status: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  /** True when the guest is in a different room type than they booked. */
  readonly upgraded: boolean;
}

export interface StayViewRoom {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly floor: string | null;
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly housekeepingStatus: string;
  readonly isActive: boolean;
  readonly stays: readonly StayViewOccupancy[];
}

export interface StayView {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly dates: readonly IsoDate[];
  readonly rooms: readonly StayViewRoom[];
  /** Booked but not yet in a room — the front desk's actual worklist. */
  readonly unassigned: readonly (StayViewOccupancy & {
    readonly roomTypeId: string;
    readonly roomTypeName: string;
  })[];
}

/**
 * Who is in which room (roadmap Phase 4).
 *
 * A DIFFERENT question from the inventory grid, and deliberately a different
 * screen. Inventory answers "what can I sell and for how much" and drives the
 * OTAs; this answers "where do I put people tonight" and drives housekeeping
 * and check-in. Competitor products fold the two together, which is how a room
 * count starts looking like availability — the exact confusion ADR-0002 exists
 * to prevent.
 *
 * Nothing here is used by any availability calculation.
 */
@Injectable()
export class GetStayViewQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(propertyId: string, from: IsoDate, to: IsoDate): Promise<StayView> {
    const organizationId = requireOrganizationId();

    const rooms = await this.db
      .select({
        roomId: physicalRooms.id,
        roomNumber: physicalRooms.roomNumber,
        floor: physicalRooms.floor,
        roomTypeId: physicalRooms.roomTypeId,
        roomTypeName: roomTypes.name,
        housekeepingStatus: physicalRooms.housekeepingStatus,
        isActive: physicalRooms.isActive,
      })
      .from(physicalRooms)
      .innerJoin(roomTypes, eq(roomTypes.id, physicalRooms.roomTypeId))
      .where(
        and(
          eq(physicalRooms.organizationId, organizationId),
          eq(physicalRooms.propertyId, propertyId),
        ),
      )
      .orderBy(
        asc(physicalRooms.floor),
        asc(sql`substring(${physicalRooms.roomNumber} from '^[0-9]+')::bigint`),
        asc(physicalRooms.roomNumber),
      );

    // Everything overlapping the window, assigned or not. Cancelled bookings
    // are excluded: they are not arriving, and showing them would make the
    // hotel look fuller than it is.
    const overlapping = await this.db
      .select({
        stayId: reservationStays.id,
        reservationId: reservationStays.reservationId,
        reservationCode: reservations.code,
        guestName: reservationStays.guestName,
        bookerName: reservations.bookerName,
        status: reservations.status,
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
        assignedRoomId: reservationStays.assignedRoomId,
        stayRoomTypeId: reservationStays.roomTypeId,
        stayRoomTypeName: roomTypes.name,
        assignedRoomTypeId: physicalRooms.roomTypeId,
      })
      .from(reservationStays)
      .innerJoin(reservations, eq(reservations.id, reservationStays.reservationId))
      .innerJoin(roomTypes, eq(roomTypes.id, reservationStays.roomTypeId))
      .leftJoin(physicalRooms, eq(physicalRooms.id, reservationStays.assignedRoomId))
      .where(
        and(
          eq(reservationStays.organizationId, organizationId),
          eq(reservationStays.propertyId, propertyId),
          ne(reservations.status, 'CANCELLED'),
          // Half-open on both sides: a stay leaving on `from` does not appear,
          // and one arriving on `to` does not either.
          sql`daterange(${reservationStays.checkIn}, ${reservationStays.checkOut}, '[)')
              && daterange(${from}::date, ${to}::date, '[)')`,
        ),
      );

    const byRoom = new Map<string, StayViewOccupancy[]>();
    const unassigned: (StayViewOccupancy & { roomTypeId: string; roomTypeName: string })[] = [];

    for (const row of overlapping) {
      const occupancy: StayViewOccupancy = {
        stayId: row.stayId,
        reservationId: row.reservationId,
        reservationCode: row.reservationCode,
        // The stay's own guest name when one was given — a two-room booking
        // can name each occupant — otherwise whoever made the booking. A front
        // desk needs a person, not a reservation code.
        guestName: row.guestName ?? row.bookerName,
        status: row.status,
        checkIn: toIsoDate(row.checkIn),
        checkOut: toIsoDate(row.checkOut),
        upgraded: row.assignedRoomTypeId !== null && row.assignedRoomTypeId !== row.stayRoomTypeId,
      };

      if (row.assignedRoomId === null) {
        unassigned.push({
          ...occupancy,
          roomTypeId: row.stayRoomTypeId,
          roomTypeName: row.stayRoomTypeName,
        });
        continue;
      }

      const list = byRoom.get(row.assignedRoomId) ?? [];
      list.push(occupancy);
      byRoom.set(row.assignedRoomId, list);
    }

    return {
      from,
      to,
      dates: dateRange(from, to),
      rooms: rooms.map((room) => ({
        ...room,
        stays: (byRoom.get(room.roomId) ?? []).sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
      })),
      unassigned: [...unassigned].sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
    };
  }
}
