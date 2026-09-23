import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyProfile,
  type PropertyRepository,
  type UpdatePropertyFields,
} from '../domain/property.repository';

export interface UpdatePropertyInput {
  readonly propertyId: string;
  readonly fields: UpdatePropertyFields;
}

/**
 * Edit what a property says about itself.
 *
 * Deliberately NOT here: code (OTA mappings and every URL resolve on it),
 * timezone and currency (every stored night and price is denominated in
 * them), tax rates (accounting settings own those, and a booking already
 * priced must not be re-taxed by a form), and status. Each of those is a
 * migration of data or a commercial decision, not a field on a page.
 *
 * Coordinates come as a pair or not at all: a latitude with no longitude puts
 * the hotel on the prime meridian, which Google will happily match to a spot
 * in the Gulf of Guinea.
 */
@Injectable()
export class UpdatePropertyUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PROPERTY_REPOSITORY) private readonly repo: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UpdatePropertyInput, actor: AuditActor): Promise<PropertyProfile> {
    const organizationId = requireOrganizationId();
    if (Object.keys(input.fields).length === 0) throw errors.validation('No fields to update');

    return this.db.transaction(async (tx) => {
      const before = await this.repo.findProfile(tx, input.propertyId);
      if (!before) throw errors.notFound('Property', input.propertyId);

      const latitude = input.fields.latitude ?? before.latitude;
      const longitude = input.fields.longitude ?? before.longitude;
      if ((latitude === null) !== (longitude === null)) {
        throw errors.validation('Latitude and longitude go together — give both or neither');
      }

      await this.repo.updateProfile(tx, input.propertyId, input.fields);

      const after = await this.repo.findProfile(tx, input.propertyId);
      if (!after) {
        throw new DomainError('INTERNAL_ERROR', 'Property could not be read back after update');
      }

      await this.audit.record(tx, {
        organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'property.updated',
        entityType: 'property',
        entityId: input.propertyId,
        before: changed(before, after, 'before'),
        after: changed(before, after, 'after'),
      });

      return after;
    });
  }
}

/** Only what moved, so the activity log reads "phone: old → new" not a wall of unchanged fields. */
function changed(
  before: PropertyProfile,
  after: PropertyProfile,
  side: 'before' | 'after',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof PropertyProfile)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      out[key] = side === 'before' ? before[key] : after[key];
    }
  }
  return out;
}
