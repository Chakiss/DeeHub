import { errors } from '@deehub/shared';
import type { RoomRecord } from './room.repository';

/**
 * Can a guest be put in this room at all?
 *
 * One rule, shared by every path that assigns: the front desk moving a booking
 * into a room later, and the booking form choosing one up front. Out of
 * service means the room does not exist for guests; out of order means it
 * exists but nobody should sleep in it. Dirty is deliberately allowed — the
 * room will be clean by the time the guest arrives, and refusing it would
 * block every same-day turnover.
 *
 * Whether the room is FREE on the nights in question is not decided here. The
 * database owns that (the room-overlap exclusion constraint), because a check
 * made before the write cannot be made atomic with it.
 */
export function assertRoomAssignable(room: RoomRecord): void {
  if (!room.isActive) {
    throw errors.validation(`Room ${room.roomNumber} is not in service`);
  }
  if (room.housekeepingStatus === 'OUT_OF_ORDER') {
    throw errors.validation(`Room ${room.roomNumber} is out of order`);
  }
}
