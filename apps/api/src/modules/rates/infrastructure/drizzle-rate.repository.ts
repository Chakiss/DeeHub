import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { money, toIsoDate, type IsoDate, type Money } from '@deehub/shared';
import { ratePlans, rateDays, roomTypes } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { LeadRate, RateRepository, RateRow } from '../domain/rate.repository';

@Injectable()
export class DrizzleRateRepository implements RateRepository {
  async findPrices(
    tx: Executor,
    ratePlanId: string,
    dates: readonly IsoDate[],
    occupancy: number,
  ): Promise<Map<string, Money>> {
    if (dates.length === 0) return new Map();
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        date: rateDays.date,
        amountMinor: rateDays.amountMinor,
        currency: rateDays.currency,
      })
      .from(rateDays)
      .where(
        and(
          eq(rateDays.organizationId, organizationId),
          eq(rateDays.ratePlanId, ratePlanId),
          eq(rateDays.occupancy, occupancy),
          inArray(rateDays.date, [...dates]),
        ),
      );

    return new Map(rows.map((row) => [row.date, money(row.amountMinor, row.currency)]));
  }

  async findRatesForPlans(
    tx: Executor,
    ratePlanIds: readonly string[],
    dates: readonly IsoDate[],
  ): Promise<readonly RateRow[]> {
    if (ratePlanIds.length === 0 || dates.length === 0) return [];
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        ratePlanId: rateDays.ratePlanId,
        date: rateDays.date,
        occupancy: rateDays.occupancy,
        amountMinor: rateDays.amountMinor,
        currency: rateDays.currency,
      })
      .from(rateDays)
      .where(
        and(
          eq(rateDays.organizationId, organizationId),
          inArray(rateDays.ratePlanId, [...ratePlanIds]),
          inArray(rateDays.date, [...dates]),
        ),
      )
      .orderBy(rateDays.date, rateDays.occupancy);

    return rows.map((row) => ({ ...row, date: toIsoDate(row.date) }));
  }

  async findLeadRates(
    tx: Executor,
    propertyId: string,
    roomTypeIds: readonly string[],
    dates: readonly IsoDate[],
  ): Promise<readonly LeadRate[]> {
    if (roomTypeIds.length === 0 || dates.length === 0) return [];
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        roomTypeId: ratePlans.roomTypeId,
        date: rateDays.date,
        amountMinor: sql<number>`min(${rateDays.amountMinor})::int`,
        currency: rateDays.currency,
        planCount: sql<number>`count(distinct ${ratePlans.id})::int`,
      })
      .from(rateDays)
      // Inactive plans are excluded: a price nobody can book should not be the
      // number an operator reads off the grid.
      .innerJoin(
        ratePlans,
        and(eq(ratePlans.id, rateDays.ratePlanId), eq(ratePlans.isActive, true)),
      )
      // Joined to compare occupancy against each room type's OWN standard.
      // A fixed occupancy would silently show nothing for a family room whose
      // standard is 4.
      .innerJoin(
        roomTypes,
        and(
          eq(roomTypes.id, ratePlans.roomTypeId),
          eq(rateDays.occupancy, roomTypes.standardOccupancy),
        ),
      )
      .where(
        and(
          eq(rateDays.organizationId, organizationId),
          eq(rateDays.propertyId, propertyId),
          inArray(ratePlans.roomTypeId, [...roomTypeIds]),
          inArray(rateDays.date, [...dates]),
        ),
      )
      // Currency is grouped, not aggregated: a property has one currency
      // (ADR-0003), so a second row here would mean data we should not average
      // over anyway.
      .groupBy(ratePlans.roomTypeId, rateDays.date, rateDays.currency);

    return rows.map((row) => ({ ...row, date: toIsoDate(row.date) }));
  }
}
