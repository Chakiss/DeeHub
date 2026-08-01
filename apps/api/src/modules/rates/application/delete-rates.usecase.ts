import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  dateRange,
  dayOfWeek,
  errors,
  EVENT_TYPES,
  type DayOfWeek,
  type IsoDate,
} from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { inventoryDays, rateDays, ratePlans } from '../../../database/schema';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';

export interface RateDeletion {
  readonly ratePlanId: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly daysOfWeek?: readonly DayOfWeek[];
  /** Absent means every occupancy on those nights. */
  readonly occupancies?: readonly number[];
}

export interface DeleteRatesInput {
  readonly propertyId: string;
  readonly deletions: readonly RateDeletion[];
}

export interface DeleteRatesResult {
  readonly pricesRemoved: number;
  /**
   * Nights that still have allotment but can no longer be sold at all, because
   * no active rate plan for that room type prices them any more.
   *
   * The number a manager actually needs: removing a price is usually meant to
   * undo a mistake, and doing it to the wrong range takes the hotel off sale
   * silently — a booking is simply refused, and nothing else says why.
   */
  readonly nightsNowUnsellable: number;
}

/** Enough to reconstruct a small mistake; a season is re-entered, not replayed. */
const AUDIT_SAMPLE_LIMIT = 50;

/**
 * Remove nightly prices (api-spec.md §6.4).
 *
 * The counterpart to `UpdateRatesUseCase`, which only ever upserts. Until this
 * existed a mis-typed price could not be taken back — only overwritten — and
 * the obvious workaround was to type `0`, which does NOT make the night
 * unsellable. It makes the room sellable FOR FREE, which is worse than the
 * mistake being corrected.
 *
 * Existing reservations are untouched. Their per-night prices were snapshotted
 * at booking time, so removing a rate never changes what a guest was quoted
 * (domain-model.md §3.5).
 */
@Injectable()
export class DeleteRatesUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DeleteRatesInput, actor: AuditActor): Promise<DeleteRatesResult> {
    const tenant = requireTenant();
    if (input.deletions.length === 0) {
      throw errors.validation('At least one deletion is required');
    }

    const planIds = [...new Set(input.deletions.map((deletion) => deletion.ratePlanId))];

    const plans = await this.db
      .select({
        id: ratePlans.id,
        roomTypeId: ratePlans.roomTypeId,
        parentRatePlanId: ratePlans.parentRatePlanId,
      })
      .from(ratePlans)
      .where(
        and(
          eq(ratePlans.organizationId, tenant.organizationId),
          eq(ratePlans.propertyId, input.propertyId),
          inArray(ratePlans.id, planIds),
        ),
      );

    const roomTypeByPlan = new Map(plans.map((plan) => [plan.id, plan.roomTypeId]));
    for (const planId of planIds) {
      // A plan in another property is indistinguishable from one that does not
      // exist (api-spec.md §4).
      if (!roomTypeByPlan.has(planId)) throw errors.notFound('Rate plan', planId);
    }

    /*
     * A derived plan has no prices to hold. Writing rows for one would put them
     * in `rate_days` where `effective_rate_days` never looks — the plan would
     * keep quoting its parent's offset while the editor showed the numbers
     * somebody just typed. Refusing says which plan to edit instead.
     */
    const derived = plans.filter((plan) => plan.parentRatePlanId !== null);
    if (derived.length > 0) {
      throw errors.validation(
        'A derived plan takes its price from its parent and cannot be cleared directly. ' +
          'Change the parent plan, or the derivation.',
        { ratePlanIds: derived.map((plan) => plan.id) },
      );
    }

    return this.db.transaction(async (tx) => {
      let pricesRemoved = 0;
      const events: OutboxEventInput[] = [];
      /** Room type → the nights it lost a price on, for the unsellable count. */
      const touched = new Map<string, Set<IsoDate>>();

      for (const deletion of input.deletions) {
        const dates = this.expand(deletion);
        if (dates.length === 0) continue;

        const conditions = [
          eq(rateDays.organizationId, tenant.organizationId),
          eq(rateDays.propertyId, input.propertyId),
          eq(rateDays.ratePlanId, deletion.ratePlanId),
          inArray(rateDays.date, [...dates]),
        ];
        if (deletion.occupancies && deletion.occupancies.length > 0) {
          conditions.push(inArray(rateDays.occupancy, [...deletion.occupancies]));
        }

        // Read before deleting: once the rows are gone the audit trail is the
        // only record of what the prices were.
        const removed = await tx
          .select({
            date: rateDays.date,
            occupancy: rateDays.occupancy,
            amountMinor: rateDays.amountMinor,
          })
          .from(rateDays)
          .where(and(...conditions))
          .orderBy(rateDays.date, rateDays.occupancy);

        if (removed.length === 0) continue;

        await tx.delete(rateDays).where(and(...conditions));
        pricesRemoved += removed.length;

        const roomTypeId = roomTypeByPlan.get(deletion.ratePlanId) as string;
        const forRoomType = touched.get(roomTypeId) ?? new Set<IsoDate>();
        for (const row of removed) forRoomType.add(row.date as IsoDate);
        touched.set(roomTypeId, forRoomType);

        const removedDates = [...new Set(removed.map((row) => row.date))].sort();

        events.push({
          type: EVENT_TYPES.RATE_CHANGED,
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          aggregateType: 'rate',
          aggregateId: deletion.ratePlanId,
          payload: {
            propertyId: input.propertyId,
            ratePlanId: deletion.ratePlanId,
            // The relay keys the dirty ARI window by room type, not rate plan.
            roomTypeId,
            from: removedDates[0],
            to: removedDates[removedDates.length - 1],
          },
        });

        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'rate.deleted',
          entityType: 'ratePlan',
          entityId: deletion.ratePlanId,
          // `before` because these prices no longer exist. A restore means
          // re-entering them, and this is where to read them from.
          before: {
            prices: removed.slice(0, AUDIT_SAMPLE_LIMIT).map((row) => ({
              date: row.date,
              occupancy: row.occupancy,
              amount: row.amountMinor,
            })),
            // Never a silent cap: a manager reading this must know the entry
            // lists only part of what was removed.
            truncated: removed.length > AUDIT_SAMPLE_LIMIT,
          },
          after: {
            from: removedDates[0],
            to: removedDates[removedDates.length - 1],
            nights: removedDates.length,
            pricesRemoved: removed.length,
            ...(deletion.daysOfWeek ? { daysOfWeek: [...deletion.daysOfWeek] } : {}),
            ...(deletion.occupancies ? { occupancies: [...deletion.occupancies] } : {}),
          },
        });
      }

      await this.outbox.recordMany(tx, events);

      return {
        pricesRemoved,
        nightsNowUnsellable: await this.countUnsellable(tx, input.propertyId, touched),
      };
    });
  }

  /**
   * Nights with allotment left but no price from ANY active plan of that room
   * type. Counting per rate plan would over-report: a hotel with a refundable
   * and a non-refundable plan can lose one and still sell the night.
   */
  private async countUnsellable(
    tx: Executor,
    propertyId: string,
    touched: ReadonlyMap<string, ReadonlySet<IsoDate>>,
  ): Promise<number> {
    let total = 0;

    for (const [roomTypeId, dates] of touched) {
      if (dates.size === 0) continue;

      const rows = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(inventoryDays)
        .where(
          and(
            eq(inventoryDays.propertyId, propertyId),
            eq(inventoryDays.roomTypeId, roomTypeId),
            inArray(inventoryDays.date, [...dates]),
            gt(inventoryDays.allotment, 0),
            /*
             * The correlated columns are written FULLY QUALIFIED on purpose.
             * Drizzle renders an embedded column reference as a bare "date",
             * and inside this subquery `rate_days` also has a `date`, so the
             * inner scope would win and the correlation would silently compare
             * a column with itself — every night would look still-priced.
             */
            sql`NOT EXISTS (
                  SELECT 1
                    FROM rate_days rd
                    JOIN rate_plans rp ON rp.id = rd.rate_plan_id
                   WHERE rp.room_type_id = "inventory_days"."room_type_id"
                     AND rp.is_active = TRUE
                     AND rd.date = "inventory_days"."date"
                )`,
          ),
        );

      total += rows[0]?.count ?? 0;
    }

    return total;
  }

  private expand(deletion: RateDeletion): IsoDate[] {
    const all = dateRange(deletion.from, deletion.to);
    if (!deletion.daysOfWeek || deletion.daysOfWeek.length === 0) return all;
    const wanted = new Set(deletion.daysOfWeek);
    return all.filter((date) => wanted.has(dayOfWeek(date)));
  }
}
