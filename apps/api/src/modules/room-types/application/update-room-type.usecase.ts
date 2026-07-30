import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRecord,
  type RoomTypeRepository,
  type UpdateRoomTypeFields,
} from '../domain/room-type.repository';
import { assertOccupancy } from './room-type.rules';

export interface UpdateRoomTypeInput {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly fields: UpdateRoomTypeFields;
}

/**
 * Update a room type.
 *
 * The code is deliberately NOT updatable. It is what OTA mappings, imports and
 * a hotel's own paperwork refer to, so changing it silently repoints every one
 * of those at a different room — with no error anywhere. Correcting a genuinely
 * wrong code means deactivating the type and creating the right one, which
 * keeps the old bookings attached to what was actually sold.
 */
@Injectable()
export class UpdateRoomTypeUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly repo: RoomTypeRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UpdateRoomTypeInput, actor: AuditActor): Promise<RoomTypeRecord> {
    const organizationId = requireOrganizationId();

    const before = await this.repo.findById(this.db, input.propertyId, input.roomTypeId);
    if (!before) throw errors.notFound('Room type', input.roomTypeId);

    if (Object.keys(input.fields).length === 0) {
      throw errors.validation('No fields to update');
    }

    // Validate the shape the row will END UP with, not just what was sent.
    // Raising maxAdults alone is valid or not depending on the maxOccupancy
    // already stored, and checking the patch in isolation cannot tell.
    assertOccupancy({
      standardOccupancy: input.fields.standardOccupancy ?? before.standardOccupancy,
      maxOccupancy: input.fields.maxOccupancy ?? before.maxOccupancy,
      maxAdults: input.fields.maxAdults ?? before.maxAdults,
      maxChildren: input.fields.maxChildren ?? before.maxChildren,
    });

    return this.db.transaction(async (tx) => {
      await this.repo.update(tx, input.propertyId, input.roomTypeId, input.fields);

      const after = await this.repo.findById(tx, input.propertyId, input.roomTypeId);
      if (!after) {
        throw new DomainError('INTERNAL_ERROR', 'Room type could not be read back after update');
      }

      await this.audit.record(tx, {
        organizationId,
        propertyId: input.propertyId,
        actor,
        // Deactivation is the closest thing to a delete this system has, so it
        // gets its own action rather than hiding inside a generic update.
        action:
          input.fields.isActive === false && before.isActive
            ? 'roomtype.deactivated'
            : 'roomtype.updated',
        entityType: 'room_type',
        entityId: input.roomTypeId,
        before: { ...before },
        after: { ...after },
      });

      return after;
    });
  }
}
