import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  dateRange,
  dayOfWeek,
  errors,
  EVENT_TYPES,
  money,
  type DayOfWeek,
  type IsoDate,
} from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { properties, rateDays, ratePlans } from '../../../database/schema';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';

export interface RatePrice {
  readonly occupancy: number;
  /** Integer minor units (ADR-0003). */
  readonly amount: number;
}

export interface RateUpdate {
  readonly ratePlanId: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly daysOfWeek?: readonly DayOfWeek[];
  readonly prices: readonly RatePrice[];
}

export interface UpdateRatesInput {
  readonly propertyId: string;
  readonly updates: readonly RateUpdate[];
}

export interface UpdateRatesResult {
  readonly pricesUpdated: number;
  readonly ratePlansTouched: number;
}

/**
 * Bulk rate edit (api-spec.md §6.4).
 *
 * Same range-and-weekday shape as inventory, because managers think in seasons
 * and weekends, not individual nights.
 *
 * Existing reservations are untouched: their per-night prices were snapshotted
 * at booking time, so changing a rate plan never rewrites what a guest was
 * already quoted (domain-model.md §3.5).
 */
@Injectable()
export class UpdateRatesUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateRatesInput, actor: AuditActor): Promise<UpdateRatesResult> {
    const tenant = requireTenant();
    if (input.updates.length === 0) {
      throw errors.validation('At least one update is required');
    }

    const currency = await this.propertyCurrency(tenant.organizationId, input.propertyId);
    const planIds = [...new Set(input.updates.map((update) => update.ratePlanId))];

    // One lookup for validation AND the room type each event needs, rather than
    // a query per update.
    const plans = await this.db
      .select({ id: ratePlans.id, roomTypeId: ratePlans.roomTypeId })
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

    return this.db.transaction(async (tx) => {
      let pricesUpdated = 0;
      const events: OutboxEventInput[] = [];

      for (const update of input.updates) {
        const dates = this.expand(update);
        if (dates.length === 0 || update.prices.length === 0) continue;

        const values = dates.flatMap((date) =>
          update.prices.map((price) => {
            if (!Number.isInteger(price.occupancy) || price.occupancy < 1) {
              throw errors.validation('Occupancy must be a positive integer', {
                ratePlanId: update.ratePlanId,
                occupancy: price.occupancy,
              });
            }
            // money() rejects decimals and malformed currencies before they
            // reach the database.
            const amount = money(price.amount, currency);
            if (amount.amount < 0) {
              throw errors.validation('Price cannot be negative', {
                ratePlanId: update.ratePlanId,
              });
            }
            return {
              organizationId: tenant.organizationId,
              propertyId: input.propertyId,
              ratePlanId: update.ratePlanId,
              date,
              occupancy: price.occupancy,
              amountMinor: amount.amount,
              currency: amount.currency,
            };
          }),
        );

        await tx
          .insert(rateDays)
          .values(values)
          .onConflictDoUpdate({
            target: [rateDays.ratePlanId, rateDays.date, rateDays.occupancy],
            set: {
              amountMinor: sql`excluded.amount_minor`,
              currency: sql`excluded.currency`,
              updatedAt: new Date(),
            },
          });

        pricesUpdated += values.length;

        events.push({
          type: EVENT_TYPES.RATE_CHANGED,
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          aggregateType: 'rate',
          aggregateId: update.ratePlanId,
          payload: {
            propertyId: input.propertyId,
            ratePlanId: update.ratePlanId,
            // The relay keys the dirty ARI window by room type, not rate plan.
            roomTypeId: roomTypeByPlan.get(update.ratePlanId),
            from: dates[0],
            to: dates[dates.length - 1],
          },
        });

        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'rate.updated',
          entityType: 'ratePlan',
          entityId: update.ratePlanId,
          after: {
            from: dates[0],
            to: dates[dates.length - 1],
            nights: dates.length,
            prices: update.prices.map((price) => ({ ...price })),
            ...(update.daysOfWeek ? { daysOfWeek: [...update.daysOfWeek] } : {}),
          },
        });
      }

      await this.outbox.recordMany(tx, events);
      return {
        pricesUpdated,
        ratePlansTouched: planIds.length,
      };
    });
  }

  private async propertyCurrency(organizationId: string, propertyId: string): Promise<string> {
    const rows = await this.db
      .select({ currency: properties.currency })
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.organizationId, organizationId)))
      .limit(1);

    const currency = rows[0]?.currency;
    if (!currency) throw errors.notFound('Property', propertyId);
    return currency;
  }

  private expand(update: RateUpdate): IsoDate[] {
    const all = dateRange(update.from, update.to);
    if (!update.daysOfWeek || update.daysOfWeek.length === 0) return all;
    const wanted = new Set(update.daysOfWeek);
    return all.filter((date) => wanted.has(dayOfWeek(date)));
  }
}
