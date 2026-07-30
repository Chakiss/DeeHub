import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { errors, money, nightsBetween, sum, type IsoDate, type Money } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { ratePlans, roomTypes } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import type { InventoryDay } from '../../inventory/domain/inventory-day';
import { evaluateStay, isSellable } from '../../inventory/domain/restrictions';
import { RATE_REPOSITORY, type RateRepository } from '../../rates/domain/rate.repository';

export interface AvailabilityRatePlan {
  readonly ratePlanId: string;
  readonly code: string;
  readonly name: string;
  readonly total: Money;
  readonly perNight: readonly { date: IsoDate; amount: Money }[];
  readonly bookable: boolean;
  readonly reason?: string;
}

export interface AvailabilityRoomType {
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly availableUnits: number;
  readonly ratePlans: readonly AvailabilityRatePlan[];
}

export interface UnavailableRoomType {
  readonly roomTypeId: string;
  readonly name: string;
  readonly reason: 'INVENTORY_UNAVAILABLE' | 'RESTRICTION_VIOLATED' | 'OCCUPANCY_EXCEEDED';
  readonly detail: Record<string, unknown>;
}

export interface AvailabilityResult {
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly nights: number;
  readonly roomTypes: readonly AvailabilityRoomType[];
  readonly unavailable: readonly UnavailableRoomType[];
}

/**
 * Availability search (api-spec.md §6.5).
 *
 * Unbookable room types are returned WITH A REASON rather than omitted. Staff
 * taking a phone booking need to see that a room is blocked by a three-night
 * minimum, not silently wonder why it vanished from the list — and "why can't I
 * sell this room?" is otherwise a support call.
 */
@Injectable()
export class SearchAvailabilityQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
  ) {}

  async execute(
    propertyId: string,
    checkIn: IsoDate,
    checkOut: IsoDate,
    adults: number,
    children = 0,
  ): Promise<AvailabilityResult> {
    const organizationId = requireOrganizationId();
    // Throws when check-out is not after check-in, so date order is enforced by
    // the shared kernel rather than re-checked here.
    const nights = nightsBetween(checkIn, checkOut);

    const types = await this.db
      .select({
        id: roomTypes.id,
        code: roomTypes.code,
        name: roomTypes.name,
        maxOccupancy: roomTypes.maxOccupancy,
        maxAdults: roomTypes.maxAdults,
        maxChildren: roomTypes.maxChildren,
      })
      .from(roomTypes)
      .where(
        and(
          eq(roomTypes.organizationId, organizationId),
          eq(roomTypes.propertyId, propertyId),
          eq(roomTypes.isActive, true),
        ),
      )
      .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.code));

    if (types.length === 0) {
      return { checkIn, checkOut, nights: nights.length, roomTypes: [], unavailable: [] };
    }

    // Read-only: no locking. A search is advisory, and the booking path
    // re-validates under a lock anyway.
    const inventoryRows = await this.inventory.findRange(
      this.db,
      propertyId,
      types.map((type) => type.id),
      checkIn,
      checkOut,
    );

    // Restrictions need the departure date too (closed-to-departure).
    const departureRows = await this.inventory.findRange(
      this.db,
      propertyId,
      types.map((type) => type.id),
      checkOut,
      nextDay(checkOut),
    );

    const byRoomType = new Map<string, Map<string, InventoryDay>>();
    for (const row of [...inventoryRows, ...departureRows]) {
      const forType = byRoomType.get(row.roomTypeId) ?? new Map<string, InventoryDay>();
      forType.set(row.date, row);
      byRoomType.set(row.roomTypeId, forType);
    }

    const plans = await this.db
      .select({
        id: ratePlans.id,
        code: ratePlans.code,
        name: ratePlans.name,
        roomTypeId: ratePlans.roomTypeId,
      })
      .from(ratePlans)
      .where(
        and(
          eq(ratePlans.organizationId, organizationId),
          eq(ratePlans.propertyId, propertyId),
          eq(ratePlans.isActive, true),
        ),
      );

    const available: AvailabilityRoomType[] = [];
    const unavailable: UnavailableRoomType[] = [];

    for (const type of types) {
      if (
        adults > type.maxAdults ||
        children > type.maxChildren ||
        adults + children > type.maxOccupancy
      ) {
        unavailable.push({
          roomTypeId: type.id,
          name: type.name,
          reason: 'OCCUPANCY_EXCEEDED',
          detail: {
            maxOccupancy: type.maxOccupancy,
            maxAdults: type.maxAdults,
            maxChildren: type.maxChildren,
            requested: { adults, children },
          },
        });
        continue;
      }

      const calendar = byRoomType.get(type.id) ?? new Map<string, InventoryDay>();
      const request = { roomTypeId: type.id, nights, checkOut, units: 1 };
      const report = evaluateStay(request, calendar);

      if (!isSellable(report)) {
        const violation = report.violations[0];
        unavailable.push({
          roomTypeId: type.id,
          name: type.name,
          reason: violation ? 'RESTRICTION_VIOLATED' : 'INVENTORY_UNAVAILABLE',
          detail: violation
            ? { restriction: violation.restriction, date: violation.date, ...violation.detail }
            : { unavailableDates: [...report.soldOutDates, ...report.missingDates] },
        });
        continue;
      }

      // A stay is only sellable if EVERY night has a free unit, so the count is
      // the minimum across the stay, not the average or the first night.
      const units = Math.min(
        ...nights.map((night) => {
          const day = calendar.get(night);
          return day ? day.allotment - day.booked : 0;
        }),
      );

      const typePlans: AvailabilityRatePlan[] = [];
      for (const plan of plans.filter((candidate) => candidate.roomTypeId === type.id)) {
        // Occupancy-based pricing keys on the adult count, matching what OTAs
        // send and what the booking path will charge.
        const priced = await this.rates.findPrices(this.db, plan.id, nights, adults);
        const missing = nights.filter((night) => !priced.has(night));

        if (missing.length > 0) {
          typePlans.push({
            ratePlanId: plan.id,
            code: plan.code,
            name: plan.name,
            total: money(0, 'THB'),
            perNight: [],
            bookable: false,
            reason: `No price configured for ${String(adults)} guest(s) on ${missing.join(', ')}`,
          });
          continue;
        }

        const perNight = nights.map((night) => ({
          date: night,
          amount: priced.get(night) as Money,
        }));
        const currency = perNight[0]?.amount.currency ?? 'THB';

        typePlans.push({
          ratePlanId: plan.id,
          code: plan.code,
          name: plan.name,
          total: sum(
            perNight.map((entry) => entry.amount),
            currency,
          ),
          perNight,
          bookable: true,
        });
      }

      if (typePlans.length === 0) {
        unavailable.push({
          roomTypeId: type.id,
          name: type.name,
          reason: 'INVENTORY_UNAVAILABLE',
          detail: { message: 'No active rate plan for this room type' },
        });
        continue;
      }

      available.push({
        roomTypeId: type.id,
        code: type.code,
        name: type.name,
        availableUnits: units,
        ratePlans: typePlans,
      });
    }

    return { checkIn, checkOut, nights: nights.length, roomTypes: available, unavailable };
  }
}

function nextDay(date: IsoDate): IsoDate {
  const millis = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + 1,
  );
  const next = new Date(millis).toISOString().slice(0, 10);
  if (!next) throw errors.validation(`Invalid date: ${date}`);
  return next as IsoDate;
}
