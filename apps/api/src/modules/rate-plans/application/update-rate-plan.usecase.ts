import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  RATE_PLAN_REPOSITORY,
  type RatePlanRecord,
  type RatePlanRepository,
  type UpdateRatePlanFields,
} from '../domain/rate-plan.repository';

export interface UpdateRatePlanInput {
  readonly propertyId: string;
  readonly ratePlanId: string;
  readonly fields: UpdateRatePlanFields;
}

/**
 * Update a rate plan.
 *
 * Neither the code nor the room type can change. The code is what OTA rate
 * mappings resolve against; the room type is what every already-priced night
 * and every past reservation was sold under, so moving a plan between room
 * types would silently reattribute history.
 */
@Injectable()
export class UpdateRatePlanUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_PLAN_REPOSITORY) private readonly repo: RatePlanRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UpdateRatePlanInput, actor: AuditActor): Promise<RatePlanRecord> {
    const organizationId = requireOrganizationId();

    const before = await this.repo.findById(this.db, input.propertyId, input.ratePlanId);
    if (!before) throw errors.notFound('Rate plan', input.ratePlanId);

    if (Object.keys(input.fields).length === 0) {
      throw errors.validation('No fields to update');
    }

    return this.db.transaction(async (tx) => {
      await this.repo.update(tx, input.propertyId, input.ratePlanId, input.fields);

      const after = await this.repo.findById(tx, input.propertyId, input.ratePlanId);
      if (!after) {
        throw new DomainError('INTERNAL_ERROR', 'Rate plan could not be read back after update');
      }

      await this.audit.record(tx, {
        organizationId,
        propertyId: input.propertyId,
        actor,
        // Deactivating a plan removes it from what the grid and the OTAs price
        // against, so it is recorded distinctly from a rename.
        action:
          input.fields.isActive === false && before.isActive
            ? 'rateplan.deactivated'
            : 'rateplan.updated',
        entityType: 'rate_plan',
        entityId: input.ratePlanId,
        before: { ...before },
        after: { ...after },
      });

      return after;
    });
  }
}
