import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { roomTypes } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  CreateRoomTypeRecord,
  RoomTypeRecord,
  RoomTypeRepository,
  UpdateRoomTypeFields,
} from '../domain/room-type.repository';

const COLUMNS = {
  id: roomTypes.id,
  propertyId: roomTypes.propertyId,
  code: roomTypes.code,
  name: roomTypes.name,
  description: roomTypes.description,
  standardOccupancy: roomTypes.standardOccupancy,
  maxOccupancy: roomTypes.maxOccupancy,
  maxAdults: roomTypes.maxAdults,
  maxChildren: roomTypes.maxChildren,
  sortOrder: roomTypes.sortOrder,
  isActive: roomTypes.isActive,
};

@Injectable()
export class DrizzleRoomTypeRepository implements RoomTypeRepository {
  async list(tx: Executor, propertyId: string): Promise<readonly RoomTypeRecord[]> {
    return (
      tx
        .select(COLUMNS)
        .from(roomTypes)
        .where(this.scope(propertyId))
        // Explicit order, then name: the grid's row order is a hotel's own
        // arrangement and must not shuffle between requests.
        .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.name))
    );
  }

  async findById(
    tx: Executor,
    propertyId: string,
    roomTypeId: string,
  ): Promise<RoomTypeRecord | null> {
    const rows = await tx
      .select(COLUMNS)
      .from(roomTypes)
      .where(and(this.scope(propertyId), eq(roomTypes.id, roomTypeId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async insert(tx: Executor, record: CreateRoomTypeRecord): Promise<void> {
    await tx.insert(roomTypes).values(record);
  }

  async update(
    tx: Executor,
    propertyId: string,
    roomTypeId: string,
    fields: UpdateRoomTypeFields,
  ): Promise<void> {
    await tx
      .update(roomTypes)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(this.scope(propertyId), eq(roomTypes.id, roomTypeId)));
  }

  async maxSortOrder(tx: Executor, propertyId: string): Promise<number> {
    const rows = await tx
      .select({ value: sql<number>`coalesce(max(${roomTypes.sortOrder}), -1)::int` })
      .from(roomTypes)
      .where(this.scope(propertyId));

    return rows[0]?.value ?? -1;
  }

  /**
   * Organization AND property in every predicate. The organization clause is
   * what stops a valid propertyId from another tenant returning their rooms
   * (ADR-0001); it is not redundant with the property filter.
   */
  private scope(propertyId: string) {
    return and(
      eq(roomTypes.organizationId, requireOrganizationId()),
      eq(roomTypes.propertyId, propertyId),
    );
  }
}
