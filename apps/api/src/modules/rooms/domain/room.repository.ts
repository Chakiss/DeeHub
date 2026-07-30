import type { Executor } from '../../../database/executor';

export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

export interface RoomRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomNumber: string;
  readonly floor: string | null;
  readonly housekeepingStatus: string;
  readonly notes: string | null;
  readonly isActive: boolean;
}

export interface CreateRoomRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomNumber: string;
  readonly floor: string | null;
  readonly notes: string | null;
}

export type UpdateRoomFields = Partial<
  Pick<RoomRecord, 'roomNumber' | 'floor' | 'housekeepingStatus' | 'notes' | 'isActive'>
>;

/**
 * Physical rooms.
 *
 * These exist for assignment and housekeeping ONLY. Nothing here may ever feed
 * availability: allotment is what a property chose to sell, and deriving it
 * from a room count would turn deliberate overselling into a schema
 * limitation (ADR-0002). No method returns anything an availability query
 * could use.
 */
export interface RoomRepository {
  list(tx: Executor, propertyId: string): Promise<readonly RoomRecord[]>;
  findById(tx: Executor, propertyId: string, roomId: string): Promise<RoomRecord | null>;
  insert(tx: Executor, record: CreateRoomRecord): Promise<void>;
  update(tx: Executor, propertyId: string, roomId: string, fields: UpdateRoomFields): Promise<void>;
}

export const ROOM_REPOSITORY = Symbol('ROOM_REPOSITORY');
