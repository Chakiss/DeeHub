import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { physicalRooms } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  CreateRoomRecord,
  RoomRecord,
  RoomRepository,
  UpdateRoomFields,
} from '../domain/room.repository';

const COLUMNS = {
  id: physicalRooms.id,
  propertyId: physicalRooms.propertyId,
  roomTypeId: physicalRooms.roomTypeId,
  roomNumber: physicalRooms.roomNumber,
  floor: physicalRooms.floor,
  housekeepingStatus: physicalRooms.housekeepingStatus,
  notes: physicalRooms.notes,
  isActive: physicalRooms.isActive,
};

@Injectable()
export class DrizzleRoomRepository implements RoomRepository {
  async list(tx: Executor, propertyId: string): Promise<readonly RoomRecord[]> {
    return (
      tx
        .select(COLUMNS)
        .from(physicalRooms)
        .where(this.scope(propertyId))
        // Natural sort on the number: "10" must come after "9", not after "1".
        // Room numbers are text because "12A" and "P1" are real.
        .orderBy(
          asc(physicalRooms.floor),
          asc(sql`substring(${physicalRooms.roomNumber} from '^[0-9]+')::bigint`),
          asc(physicalRooms.roomNumber),
        )
    );
  }

  async findById(tx: Executor, propertyId: string, roomId: string): Promise<RoomRecord | null> {
    const rows = await tx
      .select(COLUMNS)
      .from(physicalRooms)
      .where(and(this.scope(propertyId), eq(physicalRooms.id, roomId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async insert(tx: Executor, record: CreateRoomRecord): Promise<void> {
    await tx.insert(physicalRooms).values(record);
  }

  async update(
    tx: Executor,
    propertyId: string,
    roomId: string,
    fields: UpdateRoomFields,
  ): Promise<void> {
    await tx
      .update(physicalRooms)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(this.scope(propertyId), eq(physicalRooms.id, roomId)));
  }

  /** Organization AND property: the organization clause is the tenant boundary. */
  private scope(propertyId: string) {
    return and(
      eq(physicalRooms.organizationId, requireOrganizationId()),
      eq(physicalRooms.propertyId, propertyId),
    );
  }
}
