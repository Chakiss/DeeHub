import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../../../database/database.module';
import { MEDIA_REPOSITORY, type MediaRepository } from '../../media/domain/media.repository';
import { OBJECT_STORE, type ObjectStore } from '../../media/domain/object-store';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  RATE_PLAN_REPOSITORY,
  type RatePlanRepository,
} from '../../rate-plans/domain/rate-plan.repository';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRepository,
} from '../../room-types/domain/room-type.repository';
import type { PublicProperty } from './public-property.resolver';

export interface PublicPhoto {
  readonly url: string;
  readonly alt: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface PublicRoomType {
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly descriptionEn: string | null;
  readonly descriptionTh: string | null;
  readonly bedConfig: string | null;
  readonly sizeSqm: number | null;
  readonly maxAdults: number;
  readonly maxChildren: number;
  readonly maxOccupancy: number;
  readonly photos: readonly PublicPhoto[];
  readonly ratePlans: readonly {
    readonly ratePlanId: string;
    readonly code: string;
    readonly name: string;
    readonly mealPlan: string;
    readonly isRefundable: boolean;
  }[];
}

export interface PublicCatalog {
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly country: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly postalCode: string | null;
  };
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly descriptionEn: string | null;
  readonly descriptionTh: string | null;
  readonly amenities: readonly string[];
  readonly checkInTime: string;
  readonly checkOutTime: string;
  readonly tax: {
    readonly vatPercent: number;
    readonly serviceChargePercent: number;
    readonly pricesIncludeTax: boolean;
  };
  readonly photos: readonly PublicPhoto[];
  readonly roomTypes: readonly PublicRoomType[];
}

/**
 * Everything a booking page shows before a date is chosen.
 *
 * Read through the same repositories the dashboard uses, inside the tenant
 * scope the resolver established, so a column added to `properties` later is
 * still not public unless it is named here. Only room types that are active
 * and have at least one plan a stranger may buy appear: a room with nothing
 * to sell online is not a room, as far as the page is concerned.
 */
@Injectable()
export class PublicCatalogQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly roomTypes: RoomTypeRepository,
    @Inject(RATE_PLAN_REPOSITORY) private readonly ratePlans: RatePlanRepository,
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepository,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async execute(property: PublicProperty): Promise<PublicCatalog | null> {
    const [profile, types, plans, photos] = await Promise.all([
      this.properties.findProfile(this.db, property.propertyId),
      this.roomTypes.list(this.db, property.propertyId),
      this.ratePlans.list(this.db, property.propertyId),
      this.media.list(this.db, property.propertyId),
    ]);
    if (!profile) return null;

    const toPhoto = (row: (typeof photos)[number]): PublicPhoto => ({
      url: this.store.publicUrl(row.objectKey),
      alt: row.alt,
      width: row.width,
      height: row.height,
    });

    const sellable = plans.filter((plan) => plan.isActive && plan.sellOnline);

    return {
      name: profile.name,
      currency: profile.currency,
      timezone: profile.timezone,
      country: profile.country,
      phone: profile.phone,
      email: profile.email,
      website: profile.website,
      address: {
        line1: profile.addressLine1,
        line2: profile.addressLine2,
        city: profile.city,
        postalCode: profile.postalCode,
      },
      latitude: profile.latitude,
      longitude: profile.longitude,
      descriptionEn: profile.descriptionEn,
      descriptionTh: profile.descriptionTh,
      amenities: profile.amenities,
      checkInTime: profile.checkInTime,
      checkOutTime: profile.checkOutTime,
      tax: {
        vatPercent: profile.taxRateBp / 100,
        serviceChargePercent: profile.serviceChargeRateBp / 100,
        pricesIncludeTax: profile.pricesIncludeTax,
      },
      photos: photos.filter((row) => row.kind === 'PROPERTY').map(toPhoto),
      roomTypes: types
        .filter((type) => type.isActive)
        .map((type) => ({
          roomTypeId: type.id,
          code: type.code,
          name: type.name,
          descriptionEn: type.description,
          descriptionTh: type.descriptionTh,
          bedConfig: type.bedConfig,
          sizeSqm: type.sizeSqm,
          maxAdults: type.maxAdults,
          maxChildren: type.maxChildren,
          maxOccupancy: type.maxOccupancy,
          photos: photos.filter((row) => row.roomTypeId === type.id).map(toPhoto),
          ratePlans: sellable
            .filter((plan) => plan.roomTypeId === type.id)
            .map((plan) => ({
              ratePlanId: plan.id,
              code: plan.code,
              name: plan.name,
              mealPlan: plan.mealPlan,
              isRefundable: plan.isRefundable,
            })),
        }))
        .filter((type) => type.ratePlans.length > 0),
    };
  }
}
