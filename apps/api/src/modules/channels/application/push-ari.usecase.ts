import { Inject, Injectable, Logger } from '@nestjs/common';
import { applyBasisPoints, errors, money, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import { availableUnits } from '../../inventory/domain/inventory-day';
import { RATE_REPOSITORY, type RateRepository } from '../../rates/domain/rate.repository';
import { ConnectorRegistry } from '../domain/connector.registry';
import { CHANNEL_REPOSITORY, type ChannelRepository } from '../domain/channel.repository';
import type { AriNight, AriRate, PushResult } from '../domain/channel-connector';

export interface PushAriInput {
  readonly channelId: string;
  readonly roomTypeId: string;
  /** Dates flagged dirty by the relay. Order does not matter. */
  readonly dates: readonly IsoDate[];
  readonly attempt?: number;
}

/**
 * Assemble and push availability, rates and restrictions to one channel.
 *
 * This is the sync engine's outbound half. It reads current state rather than
 * replaying the change that triggered it — which is what makes the push
 * idempotent, and therefore safe under the at-least-once delivery guaranteed by
 * the outbox relay. Two pushes of the same night are indistinguishable from
 * one.
 */
@Injectable()
export class PushAriUseCase {
  private readonly logger = new Logger(PushAriUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepository,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
    private readonly registry: ConnectorRegistry,
  ) {}

  async execute(input: PushAriInput): Promise<PushResult> {
    const startedAt = new Date();
    const channel = await this.channels.findById(this.db, input.channelId);
    if (!channel) throw errors.notFound('Channel', input.channelId);

    const dates = [...input.dates].sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    if (!from || !to) return { accepted: 0, rejected: 0, warnings: [] };

    // Jobs run outside any HTTP request, so the tenant scope is established
    // here — repositories refuse to run without one.
    return runWithTenant(
      {
        organizationId: channel.organizationId,
        userId: null,
        propertyId: channel.propertyId,
        requestId: `ari-push-${channel.id}`,
      },
      async () => {
        try {
          const result = await this.push(channel, input.roomTypeId, dates);
          await this.recordOutcome(channel, input, from, to, startedAt, null);
          this.logger.log(
            `ARI pushed to ${channel.name}: ${String(result.accepted)} night(s) ` +
              `${from}..${to} for room type ${input.roomTypeId}`,
          );
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordOutcome(channel, input, from, to, startedAt, message);
          // Rethrow so BullMQ retries with backoff and eventually dead-letters.
          // Swallowing here would leave the OTA stale while everything looked
          // healthy — the failure mode that causes overbookings.
          throw error;
        }
      },
    );
  }

  private async push(
    channel: { id: string; type: string; propertyId: string },
    roomTypeId: string,
    dates: readonly IsoDate[],
  ): Promise<PushResult> {
    const context = await this.channels.loadContext(this.db, channel.id);
    if (!context) throw errors.notFound('Channel', channel.id);

    const externalRoomId = await this.channels.findRoomTypeMapping(this.db, channel.id, roomTypeId);
    if (!externalRoomId) {
      // Unmapped means the hotel has not finished connecting this channel.
      // Fail loudly rather than pushing to a guessed identifier.
      throw errors.mappingMissing(channel.id, 'roomType', roomTypeId);
    }

    const ratePlanMappings = await this.channels.findRatePlanMappings(
      this.db,
      channel.id,
      roomTypeId,
    );
    const mappingByPlan = new Map(ratePlanMappings.map((mapping) => [mapping.ratePlanId, mapping]));

    const inventory = await this.inventory.findRange(
      this.db,
      channel.propertyId,
      [roomTypeId],
      dates[0] as IsoDate,
      nextDay(dates[dates.length - 1] as IsoDate),
    );
    const inventoryByDate = new Map(inventory.map((day) => [day.date, day]));

    const rateRows =
      mappingByPlan.size > 0
        ? await this.rates.findRatesForPlans(this.db, [...mappingByPlan.keys()], dates)
        : [];

    const ratesByDate = new Map<string, AriRate[]>();
    for (const row of rateRows) {
      const mapping = mappingByPlan.get(row.ratePlanId);
      if (!mapping) continue;
      const list = ratesByDate.get(row.date) ?? [];
      list.push({
        externalRateId: mapping.externalRateId,
        occupancy: row.occupancy,
        // The channel markup, applied HERE and nowhere else: this is the only
        // point in the system where a price becomes a price-for-a-channel.
        // Doing it inside a connector would give every OTA its own rounding
        // (docs/channel-markup-plan.md §4). The row is already the resolved
        // price, so a derived rate plan's offset is applied before the markup
        // rather than being multiplied by it.
        amountMinor: applyBasisPoints(
          money(row.amountMinor, row.currency),
          mapping.rateMultiplierBp,
        ).amount,
        currency: row.currency,
      });
      ratesByDate.set(row.date, list);
    }

    const nights: AriNight[] = [];
    for (const date of dates) {
      const day = inventoryByDate.get(date);
      if (!day) {
        // The date was closed or never opened. Sending zero is the safe
        // statement: it stops the OTA selling a night we do not have.
        nights.push({
          date,
          available: 0,
          stopSell: true,
          minStay: 1,
          maxStay: null,
          closedToArrival: false,
          closedToDeparture: false,
          rates: [],
        });
        continue;
      }

      nights.push({
        date,
        available: Math.max(0, availableUnits(day)),
        stopSell: day.stopSell,
        minStay: day.minStay,
        maxStay: day.maxStay,
        closedToArrival: day.closedToArrival,
        closedToDeparture: day.closedToDeparture,
        rates: ratesByDate.get(date) ?? [],
      });
    }

    const connector = this.registry.get(context.type);
    return connector.pushAri(context, { externalRoomId, nights });
  }

  private async recordOutcome(
    channel: { id: string; organizationId: string },
    input: PushAriInput,
    from: IsoDate,
    to: IsoDate,
    startedAt: Date,
    error: string | null,
  ): Promise<void> {
    const completedAt = new Date();
    await this.db.transaction(async (tx) => {
      await this.channels.recordSyncJob(tx, {
        channelId: channel.id,
        organizationId: channel.organizationId,
        kind: 'ARI_PUSH',
        roomTypeId: input.roomTypeId,
        dateFrom: from,
        dateTo: to,
        status: error === null ? 'SUCCEEDED' : 'FAILED',
        attempts: input.attempt ?? 1,
        lastError: error?.slice(0, 1_000) ?? null,
        startedAt,
        completedAt,
      });
      await this.channels.markSynced(tx, channel.id, completedAt, error?.slice(0, 1_000) ?? null);
    });
  }
}

function nextDay(date: IsoDate): IsoDate {
  const millis = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + 1,
  );
  return new Date(millis).toISOString().slice(0, 10) as IsoDate;
}
