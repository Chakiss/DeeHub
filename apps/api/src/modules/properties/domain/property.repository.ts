import type { Executor } from '../../../database/executor';

/** Settings a booking needs from the property (currency, timezone, tax). */
export interface PropertySettings {
  readonly id: string;
  readonly organizationId: string;
  readonly timezone: string;
  readonly currency: string;
  readonly taxRateBp: number;
  readonly serviceChargeRateBp: number;
  readonly pricesIncludeTax: boolean;
  readonly status: string;
}

export interface RoomTypeSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly name: string;
  readonly standardOccupancy: number;
  readonly maxOccupancy: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
  readonly isActive: boolean;
}

export interface RatePlanSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly name: string;
  readonly isActive: boolean;
}

/**
 * Read access to property configuration.
 *
 * Every method is organization-scoped from the ambient tenant context, so a
 * caller cannot reach another tenant's property even by passing a valid id
 * (ADR-0001).
 */
export interface PropertyRepository {
  findProperty(tx: Executor, propertyId: string): Promise<PropertySettings | null>;
  findRoomType(tx: Executor, roomTypeId: string): Promise<RoomTypeSummary | null>;
  findRatePlan(tx: Executor, ratePlanId: string): Promise<RatePlanSummary | null>;
}

export const PROPERTY_REPOSITORY = Symbol('PROPERTY_REPOSITORY');
