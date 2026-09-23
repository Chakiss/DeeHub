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

/**
 * Everything the dashboard's settings page edits and the booking page shows.
 * Tax and currency are here too, read-only on the page: they are a separate
 * decision (accounting settings) and a booking priced under one rate must not
 * be re-taxed by a typo in a form.
 */
export interface PropertyProfile {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly country: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly descriptionTh: string | null;
  readonly descriptionEn: string | null;
  readonly amenities: readonly string[];
  readonly checkInTime: string;
  readonly checkOutTime: string;
  readonly taxRateBp: number;
  readonly serviceChargeRateBp: number;
  readonly pricesIncludeTax: boolean;
  readonly status: string;
}

export type UpdatePropertyFields = Partial<
  Pick<
    PropertyProfile,
    | 'name'
    | 'addressLine1'
    | 'addressLine2'
    | 'city'
    | 'postalCode'
    | 'phone'
    | 'email'
    | 'website'
    | 'latitude'
    | 'longitude'
    | 'descriptionTh'
    | 'descriptionEn'
    | 'amenities'
    | 'checkInTime'
    | 'checkOutTime'
  >
>;

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
  findProfile(tx: Executor, propertyId: string): Promise<PropertyProfile | null>;
  updateProfile(tx: Executor, propertyId: string, fields: UpdatePropertyFields): Promise<void>;
  findRoomType(tx: Executor, roomTypeId: string): Promise<RoomTypeSummary | null>;
  findRatePlan(tx: Executor, ratePlanId: string): Promise<RatePlanSummary | null>;
}

export const PROPERTY_REPOSITORY = Symbol('PROPERTY_REPOSITORY');
