import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { properties, ratePlans, roomTypes } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type {
  PropertyRepository,
  PropertySettings,
  RatePlanSummary,
  RoomTypeSummary,
} from '../domain/property.repository';

@Injectable()
export class DrizzlePropertyRepository implements PropertyRepository {
  async findProperty(tx: Executor, propertyId: string): Promise<PropertySettings | null> {
    // requireOrganizationId() throws when no tenant scope is active, so an
    // unscoped read is impossible rather than merely discouraged.
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        id: properties.id,
        organizationId: properties.organizationId,
        timezone: properties.timezone,
        currency: properties.currency,
        taxRateBp: properties.taxRateBp,
        serviceChargeRateBp: properties.serviceChargeRateBp,
        pricesIncludeTax: properties.pricesIncludeTax,
        status: properties.status,
      })
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.organizationId, organizationId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async findRoomType(tx: Executor, roomTypeId: string): Promise<RoomTypeSummary | null> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        id: roomTypes.id,
        propertyId: roomTypes.propertyId,
        name: roomTypes.name,
        standardOccupancy: roomTypes.standardOccupancy,
        maxOccupancy: roomTypes.maxOccupancy,
        maxAdults: roomTypes.maxAdults,
        maxChildren: roomTypes.maxChildren,
        isActive: roomTypes.isActive,
      })
      .from(roomTypes)
      .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.organizationId, organizationId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async findRatePlan(tx: Executor, ratePlanId: string): Promise<RatePlanSummary | null> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        id: ratePlans.id,
        propertyId: ratePlans.propertyId,
        roomTypeId: ratePlans.roomTypeId,
        name: ratePlans.name,
        isActive: ratePlans.isActive,
      })
      .from(ratePlans)
      .where(and(eq(ratePlans.id, ratePlanId), eq(ratePlans.organizationId, organizationId)))
      .limit(1);

    return rows[0] ?? null;
  }
}
