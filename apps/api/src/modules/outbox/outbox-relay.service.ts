import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { dateRange, EVENT_TYPES, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../database/database.module';
import { channels, outboxEvents } from '../../database/schema';
import { ARI_SYNC_QUEUE, REDIS, RESERVATION_DELIVERY_QUEUE } from '../../queue/queue.module';
import {
  ariDirtyKey,
  ariJobId,
  deliveryJobId,
  type AriSyncJob,
  type ReservationDeliveryJob,
} from '../../queue/queues';

/** How long to hold an ARI push back so bursts of edits collapse into one. */
const DEBOUNCE_MS = 3_000;
const BATCH_SIZE = 100;

interface OutboxRow {
  id: string;
  organizationId: string;
  propertyId: string | null;
  eventType: string;
  payload: unknown;
}

interface InventoryChangedPayload {
  propertyId: string;
  roomTypeId: string;
  from: string;
  to: string;
}

/**
 * Publishes committed domain events to BullMQ (architecture.md §5).
 *
 * The relay is what makes the outbox pattern work end to end: services write
 * events in the same transaction as the state change, and this drains them
 * afterwards. Nothing enqueues directly, so a crash can never leave OTAs
 * permanently stale, and a rollback can never push phantom availability.
 *
 * Delivery is AT-LEAST-ONCE by construction. Jobs are enqueued before the rows
 * are marked published, so a crash in between redelivers rather than loses.
 * Consumers must therefore be idempotent — ARI pushes naturally are, since they
 * send absolute state rather than deltas.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ARI_SYNC_QUEUE) private readonly ariSyncQueue: Queue,
    @Inject(RESERVATION_DELIVERY_QUEUE) private readonly deliveryQueue: Queue,
  ) {}

  /**
   * Drain one batch. Returns how many events were published.
   *
   * Safe to run in several worker instances at once: `SKIP LOCKED` means each
   * instance takes a disjoint slice instead of blocking or double-publishing.
   */
  async drainOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: outboxEvents.id,
          organizationId: outboxEvents.organizationId,
          propertyId: outboxEvents.propertyId,
          eventType: outboxEvents.eventType,
          payload: outboxEvents.payload,
        })
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(outboxEvents.occurredAt)
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });

      if (rows.length === 0) return 0;

      const published: string[] = [];
      for (const row of rows) {
        try {
          await this.publish(row);
          published.push(row.id);
        } catch (error) {
          // One bad event must not block the queue behind it. Record the
          // failure and leave the row unpublished for the next pass.
          this.logger.error(
            `Failed to publish outbox event ${row.id} (${row.eventType}): ${String(error)}`,
          );
          await tx
            .update(outboxEvents)
            .set({
              attempts: sql`${outboxEvents.attempts} + 1`,
              lastError: String(error).slice(0, 1_000),
            })
            .where(eq(outboxEvents.id, row.id));
        }
      }

      if (published.length > 0) {
        await tx
          .update(outboxEvents)
          .set({ publishedAt: new Date() })
          .where(inArray(outboxEvents.id, published));
      }

      return published.length;
    });
  }

  private async publish(row: OutboxRow): Promise<void> {
    switch (row.eventType) {
      case EVENT_TYPES.INVENTORY_CHANGED:
      case EVENT_TYPES.RATE_CHANGED:
        await this.scheduleAriPush(row);
        return;
      case EVENT_TYPES.CHANNEL_RESERVATION_RECEIVED:
        await this.scheduleDelivery(row);
        return;
      case EVENT_TYPES.RESERVATION_CREATED:
      case EVENT_TYPES.RESERVATION_MODIFIED:
      case EVENT_TYPES.RESERVATION_CANCELLED:
      case EVENT_TYPES.RESERVATION_STATUS_CHANGED:
        // Reservation events drive notifications and analytics, neither of
        // which exists yet. The inventory.changed event emitted alongside is
        // what actually reaches the OTAs, so nothing is lost by not fanning
        // these out today.
        return;
      default:
        this.logger.debug(`No consumer for event type ${row.eventType}; marking published`);
        return;
    }
  }

  /**
   * Queue an inbound booking for mapping.
   *
   * The job id is the stored booking's id, so a redelivered webhook or a
   * replayed event cannot produce two mapping jobs for the same booking.
   */
  private async scheduleDelivery(row: OutboxRow): Promise<void> {
    const payload = row.payload as { channelReservationId?: string };
    if (!payload?.channelReservationId) {
      throw new Error('channel.reservation_received payload is missing channelReservationId');
    }

    const job: ReservationDeliveryJob = {
      organizationId: row.organizationId,
      channelReservationId: payload.channelReservationId,
    };
    await this.deliveryQueue.add('deliver', job, {
      jobId: deliveryJobId(payload.channelReservationId),
    });
  }

  /**
   * Mark dates dirty and schedule a debounced push per active channel.
   *
   * Fan-out happens here rather than at write time because the number of
   * channels is a property of configuration, not of the booking: a reservation
   * should not have to know how many OTAs the hotel sells on.
   */
  private async scheduleAriPush(row: OutboxRow): Promise<void> {
    const payload = row.payload as InventoryChangedPayload;
    if (!payload?.roomTypeId || !payload.propertyId) {
      throw new Error('inventory.changed payload is missing propertyId or roomTypeId');
    }

    const dirtyDates = this.datesFromPayload(payload);
    if (dirtyDates.length === 0) return;

    const activeChannels = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.propertyId, payload.propertyId), eq(channels.status, 'ACTIVE')));

    if (activeChannels.length === 0) {
      // No channel connected yet. Not an error: a hotel running direct-only
      // still books rooms, and the event is simply consumed.
      return;
    }

    for (const channel of activeChannels) {
      await this.redis.sadd(ariDirtyKey(channel.id, payload.roomTypeId), ...dirtyDates);

      const job: AriSyncJob = {
        organizationId: row.organizationId,
        propertyId: payload.propertyId,
        channelId: channel.id,
        roomTypeId: payload.roomTypeId,
      };

      // Deterministic jobId: while a push for this channel and room type is
      // still waiting, further edits only extend the dirty set instead of
      // queueing another job. That is the coalescing described in
      // architecture.md §5.
      await this.ariSyncQueue.add(`ari:${payload.roomTypeId}`, job, {
        jobId: ariJobId(channel.id, payload.roomTypeId),
        delay: DEBOUNCE_MS,
      });
    }
  }

  /**
   * Dates the event touched.
   *
   * `to` is inclusive in cancellation payloads and exclusive in booking
   * payloads, so both ends are included here. Pushing one extra day of correct
   * availability is harmless; missing one is an overbooking.
   */
  private datesFromPayload(payload: InventoryChangedPayload): IsoDate[] {
    const from = toIsoDate(payload.from);
    const to = toIsoDate(payload.to);
    if (from === to) return [from];
    const span = dateRange(from, to);
    return span.includes(to) ? span : [...span, to];
  }
}
