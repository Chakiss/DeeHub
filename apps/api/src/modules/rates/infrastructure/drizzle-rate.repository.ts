import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { money, toIsoDate, type IsoDate, type Money } from '@deehub/shared';
import { rateDays } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { RateRepository, RateRow } from '../domain/rate.repository';

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
}
