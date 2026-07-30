import './config/load-dotenv';
import { initSentry } from './observability/sentry';

// Before every other import: Sentry instruments modules as they load, so
// anything imported earlier reports nothing.
initSentry('worker');

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import type { IsoDate } from '@deehub/shared';
import type Redis from 'ioredis';
import { ENV, type Env } from './config/env';
import { WorkerModule } from './worker.module';
import { ARI_SYNC_QUEUE, MAINTENANCE_QUEUE, REDIS } from './queue/queue.module';
import { DeliverReservationUseCase } from './modules/channels/application/deliver-reservation.usecase';
import {
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
  ariDirtyKey,
  ariJobId,
  type AriSyncJob,
  type ReservationDeliveryJob,
} from './queue/queues';
import { OutboxRelayService } from './modules/outbox/outbox-relay.service';
import { ExpireHoldsUseCase } from './modules/inventory/application/expire-holds.usecase';
import { PushAriUseCase } from './modules/channels/application/push-ari.usecase';
import { ReconcileInventoryUseCase } from './modules/inventory/application/reconcile-inventory.usecase';
import type { Queue } from 'bullmq';

/** How often to look for unpublished outbox events when the last pass was empty. */
const RELAY_IDLE_MS = 1_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();

  const logger = new Logger('Worker');
  const env = app.get<Env>(ENV);

  if (!env.REDIS_URL) {
    // Silently idling would look healthy while nothing synced. Use the
    // maintenance entrypoint for deployments with no channels.
    logger.error(
      'REDIS_URL is not configured. The worker consumes queues and cannot run without it — ' +
        'use `node dist/maintenance.js` for a deployment with no channels connected.',
    );
    await app.close();
    process.exit(1);
  }
  const redis = app.get<Redis>(REDIS);
  const relay = app.get(OutboxRelayService);
  const expireHolds = app.get(ExpireHoldsUseCase);
  const reconcile = app.get(ReconcileInventoryUseCase);
  const pushAri = app.get(PushAriUseCase);
  const deliverReservation = app.get(DeliverReservationUseCase);
  const maintenanceQueue = app.get<Queue>(MAINTENANCE_QUEUE);
  const ariQueue = app.get<Queue>(ARI_SYNC_QUEUE);

  let running = true;

  // --- Outbox relay -------------------------------------------------------
  // A poll loop rather than a queue: the outbox IS the queue, and adding a
  // second one in front of it would just move the delivery problem.
  const relayLoop = (async () => {
    while (running) {
      try {
        const published = await relay.drainOnce();
        // Drain greedily while there is work; back off only when idle, so a
        // burst of bookings reaches the OTAs in seconds rather than minutes.
        if (published === 0) {
          await new Promise((resolve) => setTimeout(resolve, RELAY_IDLE_MS));
        }
      } catch (error) {
        logger.error(`Outbox relay pass failed: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, RELAY_IDLE_MS * 5));
      }
    }
  })();

  // --- ARI sync -----------------------------------------------------------
  const ariWorker = new Worker<AriSyncJob>(
    QUEUE_NAMES.ARI_SYNC,
    async (job: Job<AriSyncJob>) => {
      const { channelId, roomTypeId } = job.data;
      const key = ariDirtyKey(channelId, roomTypeId);

      // Drain the dirty set atomically: take everything pending, then clear it.
      // Anything marked dirty after this point re-queues a fresh job, so an
      // edit made while a push is in flight is not lost.
      const [dates] = await redis
        .multi()
        .smembers(key)
        .del(key)
        .exec()
        .then((results) => [(results?.[0]?.[1] as string[]) ?? []] as const);

      if (dates.length === 0) return { pushed: 0 };

      const sorted = [...dates].sort() as IsoDate[];

      try {
        const result = await pushAri.execute({
          channelId,
          roomTypeId,
          dates: sorted,
          attempt: job.attemptsMade + 1,
        });
        return { pushed: result.accepted, rejected: result.rejected };
      } catch (error) {
        // Put the dates back before failing, so the retry still knows what was
        // dirty. Without this a failed push would silently drop the change and
        // leave the OTA selling stale availability.
        await redis.sadd(key, ...sorted);
        throw error;
      }
    },
    { connection: redis, concurrency: 5 },
  );

  // --- Inbound reservation delivery ---------------------------------------
  const deliveryWorker = new Worker<ReservationDeliveryJob>(
    QUEUE_NAMES.RESERVATION_DELIVERY,
    async (job: Job<ReservationDeliveryJob>) => {
      const outcome = await deliverReservation.execute({
        channelReservationId: job.data.channelReservationId,
      });
      // A mapping failure is recorded on the row and surfaced to staff, not
      // retried forever: retrying cannot invent a missing room-type mapping.
      return outcome;
    },
    { connection: redis, concurrency: 3 },
  );

  // --- Maintenance --------------------------------------------------------
  const maintenanceWorker = new Worker(
    QUEUE_NAMES.MAINTENANCE,
    async (job: Job) => {
      switch (job.name) {
        case MAINTENANCE_JOBS.EXPIRE_HOLDS:
          return expireHolds.execute();
        case MAINTENANCE_JOBS.RECONCILE_INVENTORY:
          return reconcile.execute();
        default:
          logger.warn(`Unknown maintenance job: ${job.name}`);
          return null;
      }
    },
    { connection: redis, concurrency: 1 },
  );

  /**
   * Re-queue when dates were marked dirty WHILE a push was in flight.
   *
   * The job drains the dirty set at the start, and BullMQ ignores `add` for a
   * jobId that is currently active — so an edit landing mid-push would leave
   * dates dirty with nothing scheduled to send them. Checking once the job has
   * completed (and its id has been released) closes that window.
   */
  ariWorker.on('completed', (job: Job<AriSyncJob>) => {
    void (async () => {
      const { channelId, roomTypeId } = job.data;
      const pending = await redis.scard(ariDirtyKey(channelId, roomTypeId));
      if (pending === 0) return;
      logger.debug(
        `${String(pending)} night(s) went dirty during the push; re-queueing ${channelId}/${roomTypeId}`,
      );
      await ariQueue.add(`ari:${roomTypeId}`, job.data, {
        jobId: ariJobId(channelId, roomTypeId),
        delay: 1_000,
      });
    })();
  });

  for (const worker of [ariWorker, deliveryWorker, maintenanceWorker]) {
    worker.on('failed', (job, error) => {
      logger.error(`Job ${job?.name ?? 'unknown'} (${job?.id ?? '?'}) failed: ${error.message}`);
    });
  }

  // Repeatable schedules. Job keys are stable, so restarting the worker
  // re-registers rather than duplicating them.
  await maintenanceQueue.add(
    MAINTENANCE_JOBS.EXPIRE_HOLDS,
    {},
    { repeat: { every: 60_000 }, jobId: 'repeat:expire-holds' },
  );
  await maintenanceQueue.add(
    MAINTENANCE_JOBS.RECONCILE_INVENTORY,
    {},
    // Nightly at 03:00 in the deployment's timezone: quiet hours, and any drift
    // is on someone's desk before the morning.
    { repeat: { pattern: '0 3 * * *' }, jobId: 'repeat:reconcile-inventory' },
  );

  logger.log(
    `DeeHub worker started (${env.NODE_ENV}): outbox relay + ARI sync + reservation delivery + maintenance`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, draining…`);
    running = false;
    // Close workers before the app context so in-flight jobs finish before the
    // database pool goes away.
    await Promise.all([ariWorker.close(), deliveryWorker.close(), maintenanceWorker.close()]);
    await relayLoop;
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
