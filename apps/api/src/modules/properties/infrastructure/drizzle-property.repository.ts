import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { properties, ratePlans, roomTypes } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type {
  PropertyProfile,
  PropertyRepository,
  PropertySettings,
  RatePlanSummary,
  RoomTypeSummary,
  UpdatePropertyFields,
} from '../domain/property.repository';

const PROFILE_COLUMNS = {
  id: properties.id,
  code: properties.code,
  name: properties.name,
  timezone: properties.timezone,
  currency: properties.currency,
  country: properties.country,
  addressLine1: properties.addressLine1,
  addressLine2: properties.addressLine2,
  city: properties.city,
  postalCode: properties.postalCode,
  phone: properties.phone,
  email: properties.email,
  website: properties.website,
  latitude: properties.latitude,
  longitude: properties.longitude,
  descriptionTh: properties.descriptionTh,
  descriptionEn: properties.descriptionEn,
  amenities: properties.amenities,
  checkInTime: properties.checkInTime,
  checkOutTime: properties.checkOutTime,
  taxRateBp: properties.taxRateBp,
  serviceChargeRateBp: properties.serviceChargeRateBp,
  pricesIncludeTax: properties.pricesIncludeTax,
  status: properties.status,
};

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

  async findProfile(tx: Executor, propertyId: string): Promise<PropertyProfile | null> {
    const organizationId = requireOrganizationId();
    const rows = await tx
      .select(PROFILE_COLUMNS)
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      // jsonb comes back untyped; anything that is not a list of strings is
      // treated as empty rather than trusted.
      amenities: Array.isArray(row.amenities)
        ? row.amenities.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }

  async updateProfile(
    tx: Executor,
    propertyId: string,
    fields: UpdatePropertyFields,
  ): Promise<void> {
    const organizationId = requireOrganizationId();
    await tx
      .update(properties)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(properties.id, propertyId), eq(properties.organizationId, organizationId)));
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
