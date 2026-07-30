import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { isUniqueViolation } from '../../../common/database/unique-violation';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRepository,
} from '../../room-types/domain/room-type.repository';
import {
  ROOM_REPOSITORY,
  type RoomRecord,
  type RoomRepository,
  type UpdateRoomFields,
} from '../domain/room.repository';

export interface CreateRoomInput {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomNumber: string;
  readonly floor?: string | null;
  readonly notes?: string | null;
}

export interface UpdateRoomInput {
  readonly propertyId: string;
  readonly roomId: string;
  readonly fields: UpdateRoomFields;
}

const NUMBER_CONSTRAINT = 'physical_rooms_property_number_uq';

@Injectable()
export class ManageRoomsUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ROOM_REPOSITORY) private readonly repo: RoomRepository,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly roomTypes: RoomTypeRepository,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateRoomInput, actor: AuditActor): Promise<RoomRecord> {
    const organizationId = requireOrganizationId();

    // The room type must exist in THIS tenant's property. The foreign key would
    // accept another organization's id without complaint.
    const roomType = await this.roomTypes.findById(this.db, input.propertyId, input.roomTypeId);
    if (!roomType) throw errors.notFound('Room type', input.roomTypeId);

    const roomNumber = input.roomNumber.trim();
    const id = newId();

    try {
      return await this.db.transaction(async (tx) => {
        const record = {
          id,
          organizationId,
          propertyId: input.propertyId,
          roomTypeId: input.roomTypeId,
          roomNumber,
          floor: input.floor?.trim() || null,
          notes: input.notes?.trim() || null,
        };

        await this.repo.insert(tx, record);
        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'room.created',
          entityType: 'physical_room',
          entityId: id,
          after: { ...record },
        });

        const created = await this.repo.findById(tx, input.propertyId, id);
        if (!created) {
          throw new DomainError('INTERNAL_ERROR', 'Room could not be read back after insert');
        }
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, NUMBER_CONSTRAINT)) {
        throw errors.conflict(`Room ${roomNumber} already exists at this property`, { roomNumber });
      }
      throw error;
    }
  }

  /**
   * The room type is deliberately not updatable.
   *
   * Moving a room between types would silently change what every past
   * assignment meant. Renumbering is allowed — hotels really do that — and the
   * unique index still protects it.
   */
  async update(input: UpdateRoomInput, actor: AuditActor): Promise<RoomRecord> {
    const organizationId = requireOrganizationId();

    const before = await this.repo.findById(this.db, input.propertyId, input.roomId);
    if (!before) throw errors.notFound('Room', input.roomId);

    if (Object.keys(input.fields).length === 0) {
      throw errors.validation('No fields to update');
    }

    try {
      return await this.db.transaction(async (tx) => {
        await this.repo.update(tx, input.propertyId, input.roomId, input.fields);

        const after = await this.repo.findById(tx, input.propertyId, input.roomId);
        if (!after) {
          throw new DomainError('INTERNAL_ERROR', 'Room could not be read back after update');
        }

        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          // Housekeeping changes many times a day; separating them keeps the
          // audit trail readable when someone asks who took a room out of order.
          action:
            input.fields.housekeepingStatus !== undefined && Object.keys(input.fields).length === 1
              ? 'room.housekeeping_changed'
              : 'room.updated',
          entityType: 'physical_room',
          entityId: input.roomId,
          before: { ...before },
          after: { ...after },
        });

        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error, NUMBER_CONSTRAINT)) {
        throw errors.conflict('Another room at this property already has that number');
      }
      throw error;
    }
  }
}
