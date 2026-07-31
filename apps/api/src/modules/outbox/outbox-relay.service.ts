import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  type JobQueue,
  type ReservationDeliveryJob,
} from '../../queue/queues';
import { ComposeNotificationsUseCase } from '../notifications/application/compose-notifications.usecase';
import type { NotificationKind } from '../notifications/domain/notification';
import type { Executor } from '../../database/executor';

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

interface ReservationPayload {
  reservationId?: string;
  status?: string;
  channelId?: string | null;
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
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(ARI_SYNC_QUEUE) private readonly ariSyncQueue: JobQueue,
    @Inject(RESERVATION_DELIVERY_QUEUE) private readonly deliveryQueue: JobQueue,
    private readonly compose: ComposeNotificationsUseCase,
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
          await this.publish(row, tx);
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

  private async publish(row: OutboxRow, tx: Executor): Promise<void> {
    switch (row.eventType) {
      case EVENT_TYPES.INVENTORY_CHANGED:
      case EVENT_TYPES.RATE_CHANGED:
        await this.scheduleAriPush(row);
        return;
      case EVENT_TYPES.CHANNEL_RESERVATION_RECEIVED:
        await this.scheduleDelivery(row);
        return;
      case EVENT_TYPES.RESERVATION_CREATED:
      case EVENT_TYPES.RESERVATION_CANCELLED:
      case EVENT_TYPES.RESERVATION_STATUS_CHANGED:
        await this.composeNotifications(row, tx);
        return;
      case EVENT_TYPES.RESERVATION_MODIFIED:
        /*
         * Nothing is sent for a modification yet, deliberately.
         *
         * "Your booking changed" is only useful if it says WHAT changed, and
         * the event carries the affected dates rather than a before-and-after
         * a guest could read. Sending a vague one would train people to ignore
         * the confirmations too.
         */
        return;
      default:
        this.logger.debug(`No consumer for event type ${row.eventType}; marking published`);
        return;
    }
  }

  /**
   * Compose the messages a reservation event owes, in this transaction.
   *
   * Written here rather than in the booking use case so that reservations stay
   * ignorant of notifications — the outbox is exactly the seam for that. The
   * rows are written inside the relay's transaction, so a crash before commit
   * leaves the event unpublished and the next pass composes them again.
   */
  private async composeNotifications(row: OutboxRow, tx: Executor): Promise<void> {
    const payload = row.payload as ReservationPayload;
    if (!payload?.reservationId) {
      throw new Error(`${row.eventType} payload is missing reservationId`);
    }

    for (const kind of this.kindsFor(row.eventType, payload)) {
      await this.compose.execute(tx, {
        organizationId: row.organizationId,
        reservationId: payload.reservationId,
        kind,
      });
    }
  }

  /**
   * Which messages an event owes.
   *
   * A booking that arrives from a channel owes two: the guest a confirmation
   * from the hotel, and the desk an alert that a room was sold while nobody
   * was looking. They are different messages to different people, not one
   * message sent twice.
   */
  private kindsFor(eventType: string, payload: ReservationPayload): NotificationKind[] {
    const kinds: NotificationKind[] = [];

    if (eventType === EVENT_TYPES.RESERVATION_CANCELLED) {
      kinds.push('BOOKING_CANCELLED');
      return kinds;
    }

    // A PENDING booking is a held quote, not a promise. Confirming it is what
    // the guest can rely on, and that arrives as a status change.
    if (payload.status === 'CONFIRMED') kinds.push('BOOKING_CONFIRMED');

    if (eventType === EVENT_TYPES.RESERVATION_CREATED && payload.channelId) {
      kinds.push('BOOKING_RECEIVED');
    }

    return kinds;
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

    if (!this.redis) {
      // A channel is active but this deployment has no Redis. Fail loudly: the
      // event stays unpublished with the error recorded, rather than the OTA
      // quietly never hearing about the change.
      throw new Error(
        'Channel sync is active but REDIS_URL is not configured; cannot schedule an ARI push',
      );
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
