import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { ratePlans } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type { DerivationType } from '../domain/derivation';
import type {
  CreateRatePlanRecord,
  RatePlanRecord,
  RatePlanRepository,
  UpdateRatePlanFields,
} from '../domain/rate-plan.repository';

/** `derivation_type` is a text column guarded by a CHECK, not an enum. */
function toRecord(row: Record<string, unknown>): RatePlanRecord {
  return {
    ...(row as unknown as RatePlanRecord),
    derivationType: row['derivationType'] as DerivationType | null,
  };
}

const COLUMNS = {
  id: ratePlans.id,
  propertyId: ratePlans.propertyId,
  roomTypeId: ratePlans.roomTypeId,
  code: ratePlans.code,
  name: ratePlans.name,
  mealPlan: ratePlans.mealPlan,
  isRefundable: ratePlans.isRefundable,
  isActive: ratePlans.isActive,
  parentRatePlanId: ratePlans.parentRatePlanId,
  derivationType: ratePlans.derivationType,
  derivationValue: ratePlans.derivationValue,
};

@Injectable()
export class DrizzleRatePlanRepository implements RatePlanRepository {
  async list(tx: Executor, propertyId: string): Promise<readonly RatePlanRecord[]> {
    const rows = await tx
      .select(COLUMNS)
      .from(ratePlans)
      .where(this.scope(propertyId))
      .orderBy(asc(ratePlans.roomTypeId), asc(ratePlans.code));
    return rows.map(toRecord);
  }

  async findById(
    tx: Executor,
    propertyId: string,
    ratePlanId: string,
  ): Promise<RatePlanRecord | null> {
    const rows = await tx
      .select(COLUMNS)
      .from(ratePlans)
      .where(and(this.scope(propertyId), eq(ratePlans.id, ratePlanId)))
      .limit(1);

    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insert(tx: Executor, record: CreateRatePlanRecord): Promise<void> {
    await tx.insert(ratePlans).values(record);
  }

  async update(
    tx: Executor,
    propertyId: string,
    ratePlanId: string,
    fields: UpdateRatePlanFields,
  ): Promise<void> {
    await tx
      .update(ratePlans)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(this.scope(propertyId), eq(ratePlans.id, ratePlanId)));
  }

  /** Organization AND property: the organization clause is the tenant boundary. */
  private scope(propertyId: string) {
    return and(
      eq(ratePlans.organizationId, requireOrganizationId()),
      eq(ratePlans.propertyId, propertyId),
    );
  }
}
