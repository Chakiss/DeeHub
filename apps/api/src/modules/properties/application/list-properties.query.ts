import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';
import { properties } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';

export interface PropertySummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly status: string;
}

/**
 * Properties the caller may act on.
 *
 * Filtered by membership, not just by organization: a front-desk user scoped to
 * one property must not see the group's other hotels in their picker.
 */
@Injectable()
export class ListPropertiesQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(
    memberships: readonly { propertyId: string | null }[],
  ): Promise<readonly PropertySummary[]> {
    const organizationId = requireOrganizationId();
    const organizationWide = memberships.some((membership) => membership.propertyId === null);
    const scopedIds = memberships
      .map((membership) => membership.propertyId)
      .filter((id): id is string => id !== null);

    if (!organizationWide && scopedIds.length === 0) return [];

    const conditions = [
      eq(properties.organizationId, organizationId),
      eq(properties.status, 'ACTIVE'),
    ];
    if (!organizationWide) {
      conditions.push(inArray(properties.id, scopedIds));
    }

    return this.db
      .select({
        id: properties.id,
        code: properties.code,
        name: properties.name,
        timezone: properties.timezone,
        currency: properties.currency,
        status: properties.status,
      })
      .from(properties)
      .where(and(...conditions))
      .orderBy(asc(properties.name));
  }
}
