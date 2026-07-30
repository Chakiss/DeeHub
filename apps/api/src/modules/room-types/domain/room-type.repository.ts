import type { Executor } from '../../../database/executor';

export interface RoomTypeRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly standardOccupancy: number;
  readonly maxOccupancy: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface CreateRoomTypeRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly standardOccupancy: number;
  readonly maxOccupancy: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
  readonly sortOrder: number;
}

export type UpdateRoomTypeFields = Partial<
  Pick<
    RoomTypeRecord,
    | 'name'
    | 'description'
    | 'standardOccupancy'
    | 'maxOccupancy'
    | 'maxAdults'
    | 'maxChildren'
    | 'sortOrder'
    | 'isActive'
  >
>;

/**
 * Room type persistence.
 *
 * Organization-scoped from the ambient tenant context, like every other
 * repository (ADR-0001): passing another tenant's propertyId returns nothing
 * rather than their data.
 *
 * There is deliberately no delete. A room type is referenced by inventory,
 * rates, reservations and channel mappings with `onDelete: restrict`, so the
 * database would refuse anyway — but the more important reason is that removing
 * a room type a hotel has already sold would erase what those bookings were
 * for. `isActive: false` stops it being sold and keeps the history readable.
 */
export interface RoomTypeRepository {
  list(tx: Executor, propertyId: string): Promise<readonly RoomTypeRecord[]>;
  findById(tx: Executor, propertyId: string, roomTypeId: string): Promise<RoomTypeRecord | null>;
  insert(tx: Executor, record: CreateRoomTypeRecord): Promise<void>;
  update(
    tx: Executor,
    propertyId: string,
    roomTypeId: string,
    fields: UpdateRoomTypeFields,
  ): Promise<void>;
  /** Highest sortOrder in the property, so a new type lands at the end. */
  maxSortOrder(tx: Executor, propertyId: string): Promise<number>;
}

export const ROOM_TYPE_REPOSITORY = Symbol('ROOM_TYPE_REPOSITORY');
