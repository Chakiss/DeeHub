import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { money, toIsoDate, type IsoDate, type Money } from '@deehub/shared';
import { effectiveRateDays, ratePlans, roomTypes } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { LeadRate, RateRepository, RateRow } from '../domain/rate.repository';

/**
 * Every read here goes through `effective_rate_days`, never `rate_days`.
 *
 * A derived plan keeps no rows of its own — its price is its parent's, offset —
 * and the view is the one place that resolves it. Reading the table directly
 * would quietly return nothing for a derived plan, which presents as "that
 * night has no price" rather than as a bug.
 *
 * WRITES still go to `rate_days` (see `DrizzleRateWriteRepository` in
 * update-rates), because a derived plan has nothing to write.
 */
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
        date: effectiveRateDays.date,
        amountMinor: effectiveRateDays.amountMinor,
        currency: effectiveRateDays.currency,
      })
      .from(effectiveRateDays)
      .where(
        and(
          eq(effectiveRateDays.organizationId, organizationId),
          eq(effectiveRateDays.ratePlanId, ratePlanId),
          eq(effectiveRateDays.occupancy, occupancy),
          inArray(effectiveRateDays.date, [...dates]),
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
        ratePlanId: effectiveRateDays.ratePlanId,
        date: effectiveRateDays.date,
        occupancy: effectiveRateDays.occupancy,
        amountMinor: effectiveRateDays.amountMinor,
        currency: effectiveRateDays.currency,
      })
      .from(effectiveRateDays)
      .where(
        and(
          eq(effectiveRateDays.organizationId, organizationId),
          inArray(effectiveRateDays.ratePlanId, [...ratePlanIds]),
          inArray(effectiveRateDays.date, [...dates]),
        ),
      )
      .orderBy(effectiveRateDays.date, effectiveRateDays.occupancy);

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
        date: effectiveRateDays.date,
        amountMinor: sql<number>`min(${effectiveRateDays.amountMinor})::int`,
        currency: effectiveRateDays.currency,
        planCount: sql<number>`count(distinct ${ratePlans.id})::int`,
      })
      .from(effectiveRateDays)
      // Inactive plans are excluded: a price nobody can book should not be the
      // number an operator reads off the grid. A derived plan is included and
      // may well BE the lead rate — that is usually the point of creating one.
      .innerJoin(
        ratePlans,
        and(eq(ratePlans.id, effectiveRateDays.ratePlanId), eq(ratePlans.isActive, true)),
      )
      // Joined to compare occupancy against each room type's OWN standard.
      // A fixed occupancy would silently show nothing for a family room whose
      // standard is 4.
      .innerJoin(
        roomTypes,
        and(
          eq(roomTypes.id, ratePlans.roomTypeId),
          eq(effectiveRateDays.occupancy, roomTypes.standardOccupancy),
        ),
      )
      .where(
        and(
          eq(effectiveRateDays.organizationId, organizationId),
          eq(effectiveRateDays.propertyId, propertyId),
          inArray(ratePlans.roomTypeId, [...roomTypeIds]),
          inArray(effectiveRateDays.date, [...dates]),
        ),
      )
      // Currency is grouped, not aggregated: a property has one currency
      // (ADR-0003), so a second row here would mean data we should not average
      // over anyway.
      .groupBy(ratePlans.roomTypeId, effectiveRateDays.date, effectiveRateDays.currency);

    return rows.map((row) => ({ ...row, date: toIsoDate(row.date) }));
  }
}
