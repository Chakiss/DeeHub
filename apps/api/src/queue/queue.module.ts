import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';
import { QUEUE_NAMES, type QueueName } from './queues';

export const REDIS = Symbol('REDIS');
export const ARI_SYNC_QUEUE = Symbol('ARI_SYNC_QUEUE');
export const RESERVATION_DELIVERY_QUEUE = Symbol('RESERVATION_DELIVERY_QUEUE');
export const MAINTENANCE_QUEUE = Symbol('MAINTENANCE_QUEUE');

function createQueue(connection: Redis, name: QueueName): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      // Exponential backoff with a cap on attempts, then dead-letter. A sync
      // that retries forever looks healthy while OTAs sell stale availability.
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },

      // Completed jobs are removed IMMEDIATELY, not retained.
      //
      // This is load-bearing, not tidiness. The ARI queue debounces by reusing a
      // deterministic jobId per (channel, room type); BullMQ ignores `add` while
      // a job with that id exists — including a COMPLETED one. Retaining
      // completed jobs therefore silently blocks every later change for that
      // room type until the retention window expires, so the OTA keeps selling
      // stale availability with no error anywhere. Durable sync history lives in
      // the `sync_jobs` table, so nothing is lost by dropping it here.
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
}

/**
 * BullMQ queues and the shared Redis connection.
 *
 * Redis is never a source of truth (architecture.md §7): the outbox lives in
 * Postgres, so losing Redis costs throughput and a resync, never data.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          // Required by BullMQ: it must not give up on a command mid-job.
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
        }),
    },
    {
      provide: ARI_SYNC_QUEUE,
      inject: [REDIS],
      useFactory: (connection: Redis): Queue => createQueue(connection, QUEUE_NAMES.ARI_SYNC),
    },
    {
      provide: RESERVATION_DELIVERY_QUEUE,
      inject: [REDIS],
      useFactory: (connection: Redis): Queue =>
        createQueue(connection, QUEUE_NAMES.RESERVATION_DELIVERY),
    },
    {
      provide: MAINTENANCE_QUEUE,
      inject: [REDIS],
      useFactory: (connection: Redis): Queue => createQueue(connection, QUEUE_NAMES.MAINTENANCE),
    },
  ],
  exports: [REDIS, ARI_SYNC_QUEUE, RESERVATION_DELIVERY_QUEUE, MAINTENANCE_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ARI_SYNC_QUEUE) private readonly ariSync: Queue,
    @Inject(RESERVATION_DELIVERY_QUEUE) private readonly delivery: Queue,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenance: Queue,
  ) {}

  /** Close queues before the connection so in-flight commands finish. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.ariSync.close(), this.delivery.close(), this.maintenance.close()]);
    this.redis.disconnect();
  }
}
