import { and, eq, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../../database/executor';
import { reservationStays, reservations } from '../../../database/schema';

/**
 * Which booking already holds the room over the same nights as this stay, so a
 * refusal from the room-overlap exclusion constraint can name it.
 *
 * Shared by assign-room and undo-check-out: both translate the database's
 * refusal into the same front-desk message. The database stays the authority;
 * this only explains its answer.
 */
export async function findRoomConflict(
  db: Executor,
  scope: { organizationId: string; propertyId: string },
  stayId: string,
  roomId: string,
  options: { readonly asIfNotReleased?: boolean } = {},
): Promise<{ checkIn: string; checkOut: string; reservationCode: string } | null> {
  const rows = await db
    .select({
      checkIn: reservationStays.checkIn,
      checkOut: reservationStays.checkOut,
      reservationCode: reservations.code,
    })
    .from(reservationStays)
    .innerJoin(reservations, eq(reservations.id, reservationStays.reservationId))
    .where(
      and(
        eq(reservationStays.organizationId, scope.organizationId),
        eq(reservationStays.propertyId, scope.propertyId),
        eq(reservationStays.assignedRoomId, roomId),
        ne(reservationStays.id, stayId),
        // A room a departed guest has walked out of is free from that
        // morning (room_released_on), whatever the booking's check-out says.
        // asIfNotReleased: undo check-out asks "who is in the room over the
        // dates this stay is about to hold again", while the stay's own release
        // is still recorded (the failed transaction rolled it back).
        sql`daterange(${reservationStays.checkIn}, COALESCE(${reservationStays.roomReleasedOn}, ${reservationStays.checkOut}), '[)') && (
          SELECT daterange(check_in, ${options.asIfNotReleased ? sql`check_out` : sql`COALESCE(room_released_on, check_out)`}, '[)') FROM reservation_stays WHERE id = ${stayId}
        )`,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
