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
import { assertDerivable, assertDerivationValue, type Derivation } from '../domain/derivation';
import {
  RATE_PLAN_REPOSITORY,
  type MealPlan,
  type RatePlanRecord,
  type RatePlanRepository,
} from '../domain/rate-plan.repository';

export interface CreateRatePlanInput {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly mealPlan: MealPlan;
  readonly isRefundable: boolean;
  /**
   * Absent for a plan that will hold its own prices; present for one priced as
   * an offset from another. Fixed at creation — see `UpdateRatePlanFields`.
   */
  readonly derivation?: Derivation;
}

const CODE_CONSTRAINT = 'rate_plans_property_code_uq';

@Injectable()
export class CreateRatePlanUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_PLAN_REPOSITORY) private readonly repo: RatePlanRepository,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly roomTypes: RoomTypeRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CreateRatePlanInput, actor: AuditActor): Promise<RatePlanRecord> {
    const organizationId = requireOrganizationId();

    // Confirms the room type exists in THIS tenant's property. The foreign key
    // would accept another organization's room type id perfectly happily.
    const roomType = await this.roomTypes.findById(this.db, input.propertyId, input.roomTypeId);
    if (!roomType) throw errors.notFound('Room type', input.roomTypeId);

    /*
     * Both checks before anything is written, and in this order: the value is
     * cheap to reject and does not need a query, while the parent lookup is
     * the one that can fail for a reason the operator has to act on.
     */
    if (input.derivation) {
      assertDerivationValue(input.derivation.type, input.derivation.value);
      const parent = await this.repo.findById(
        this.db,
        input.propertyId,
        input.derivation.parentRatePlanId,
      );
      assertDerivable(parent, input.derivation.parentRatePlanId, input.roomTypeId);
    }

    const code = input.code.trim().toUpperCase();
    const id = newId();

    try {
      return await this.db.transaction(async (tx) => {
        const record = {
          id,
          organizationId,
          propertyId: input.propertyId,
          roomTypeId: input.roomTypeId,
          code,
          name: input.name.trim(),
          mealPlan: input.mealPlan,
          isRefundable: input.isRefundable,
          // All three or none: a database CHECK refuses a half-configured
          // derivation, so the object is built that way rather than patched.
          parentRatePlanId: input.derivation?.parentRatePlanId ?? null,
          derivationType: input.derivation?.type ?? null,
          derivationValue: input.derivation?.value ?? null,
        };

        await this.repo.insert(tx, record);

        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'rateplan.created',
          entityType: 'rate_plan',
          entityId: id,
          after: { ...record },
        });

        const created = await this.repo.findById(tx, input.propertyId, id);
        if (!created) {
          throw new DomainError('INTERNAL_ERROR', 'Rate plan could not be read back after insert');
        }
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, CODE_CONSTRAINT)) {
        throw errors.conflict(`Rate plan code "${code}" is already used at this property`, {
          code,
        });
      }
      throw error;
    }
  }
}
