import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { assertDerivationValue } from '../domain/derivation';
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
 *
 * Nor can a plan change WHETHER it is derived. Turning a priced plan into a
 * derived one strands its `rate_days` rows — they stay in the table, the view
 * stops reading them, and every future night silently reprices; the reverse
 * leaves a plan with no prices at all. Both are migrations of data, not
 * patches to a row.
 *
 * The offset VALUE can change, and that is the point of a derived plan: moving
 * "−10%" to "−15%" reprices the whole horizon in one write. It takes effect
 * immediately for anything not yet booked; nights already sold keep the price
 * they were quoted, because those are frozen on the reservation.
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

    const newValue = input.fields.derivationValue;
    if (newValue !== undefined) {
      // Null would clear the offset and leave the CHECK constraint's pairing
      // broken, so it is refused alongside "this plan has no derivation".
      if (before.derivationType === null || newValue === null) {
        throw errors.validation('That plan holds its own prices and has no derivation to change', {
          ratePlanId: input.ratePlanId,
        });
      }
      assertDerivationValue(before.derivationType, newValue);
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
