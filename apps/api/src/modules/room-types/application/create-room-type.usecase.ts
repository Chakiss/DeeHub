import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { isUniqueViolation } from '../../../common/database/unique-violation';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRecord,
  type RoomTypeRepository,
} from '../domain/room-type.repository';
import { assertOccupancy, normalizeCode } from './room-type.rules';

export interface CreateRoomTypeInput {
  readonly propertyId: string;
  readonly code: string;
  readonly name: string;
  readonly description?: string | null;
  readonly standardOccupancy: number;
  readonly maxOccupancy: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
}

const CODE_CONSTRAINT = 'room_types_property_code_uq';

@Injectable()
export class CreateRoomTypeUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly repo: RoomTypeRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CreateRoomTypeInput, actor: AuditActor): Promise<RoomTypeRecord> {
    const organizationId = requireOrganizationId();

    // Confirms the property exists AND belongs to this tenant. Without it a
    // valid id from another organization would insert a room type into their
    // hotel — the foreign key alone would happily allow it.
    const property = await this.properties.findProperty(this.db, input.propertyId);
    if (!property) throw errors.notFound('Property', input.propertyId);

    assertOccupancy(input);
    const code = normalizeCode(input.code);
    const id = newId();

    try {
      return await this.db.transaction(async (tx) => {
        const record = {
          id,
          organizationId,
          propertyId: input.propertyId,
          code,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          standardOccupancy: input.standardOccupancy,
          maxOccupancy: input.maxOccupancy,
          maxAdults: input.maxAdults,
          maxChildren: input.maxChildren,
          sortOrder: (await this.repo.maxSortOrder(tx, input.propertyId)) + 1,
        };

        await this.repo.insert(tx, record);

        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'roomtype.created',
          entityType: 'room_type',
          entityId: id,
          after: { ...record },
        });

        const created = await this.repo.findById(tx, input.propertyId, id);
        if (!created) {
          throw new DomainError('INTERNAL_ERROR', 'Room type could not be read back after insert');
        }
        return created;
      });
    } catch (error) {
      // Checked against the code index by name: another unique index tripping
      // here would otherwise be reported as "code already in use", sending the
      // user to change the one field that was fine.
      if (isUniqueViolation(error, CODE_CONSTRAINT)) {
        throw errors.conflict(`Room type code "${code}" is already used at this property`, {
          code,
        });
      }
      throw error;
    }
  }
}
