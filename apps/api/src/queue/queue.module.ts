import { Global, Inject, Module, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DomainError } from '@deehub/shared';
import { ENV, type Env } from '../config/env';
import { QUEUE_NAMES, type JobQueue, type QueueName } from './queues';

export const REDIS = Symbol('REDIS');
export const ARI_SYNC_QUEUE = Symbol('ARI_SYNC_QUEUE');
export const RESERVATION_DELIVERY_QUEUE = Symbol('RESERVATION_DELIVERY_QUEUE');
export const MAINTENANCE_QUEUE = Symbol('MAINTENANCE_QUEUE');

/** True when this deployment is configured to talk to channels at all. */
export function channelSyncEnabled(env: Env): boolean {
  return Boolean(env.REDIS_URL);
}

/**
 * Stand-in used when REDIS_URL is absent.
 *
 * It THROWS rather than silently discarding. A deployment with no channels
 * connected never reaches it — the relay checks for active channels before
 * enqueueing anything — so hitting this means a channel was activated without
 * Redis being configured. Failing loudly leaves the outbox row unpublished
 * with an error recorded, which is exactly the alarm we want; a no-op would
 * lose the booking silently.
 */
class DisabledQueue implements JobQueue {
  constructor(private readonly name: QueueName) {}

  add(): Promise<never> {
    return Promise.reject(
      new DomainError(
        'INTERNAL_ERROR',
        `Queue "${this.name}" is disabled because REDIS_URL is not configured. ` +
          'Set it (and run the worker) before activating any channel.',
      ),
    );
  }
}

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

function queueProvider(name: QueueName) {
  return (connection: Redis | null): JobQueue =>
    connection ? createQueue(connection, name) : new DisabledQueue(name);
}

/**
 * BullMQ queues and the shared Redis connection.
 *
 * Redis is never a source of truth (architecture.md §7): the outbox lives in
 * Postgres, so losing Redis costs throughput and a resync, never data. That is
 * also why it can be omitted entirely on a deployment with no channels — see
 * docs/deployment.md.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis | null =>
        env.REDIS_URL
          ? new Redis(env.REDIS_URL, {
              // Required by BullMQ: it must not give up on a command mid-job.
              maxRetriesPerRequest: null,
              enableReadyCheck: true,
            })
          : null,
    },
    { provide: ARI_SYNC_QUEUE, inject: [REDIS], useFactory: queueProvider(QUEUE_NAMES.ARI_SYNC) },
    {
      provide: RESERVATION_DELIVERY_QUEUE,
      inject: [REDIS],
      useFactory: queueProvider(QUEUE_NAMES.RESERVATION_DELIVERY),
    },
    {
      provide: MAINTENANCE_QUEUE,
      inject: [REDIS],
      useFactory: queueProvider(QUEUE_NAMES.MAINTENANCE),
    },
  ],
  exports: [REDIS, ARI_SYNC_QUEUE, RESERVATION_DELIVERY_QUEUE, MAINTENANCE_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Optional() @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(ARI_SYNC_QUEUE) private readonly ariSync: JobQueue,
    @Inject(RESERVATION_DELIVERY_QUEUE) private readonly delivery: JobQueue,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenance: JobQueue,
  ) {}

  /** Close queues before the connection so in-flight commands finish. */
  async onApplicationShutdown(): Promise<void> {
    for (const queue of [this.ariSync, this.delivery, this.maintenance]) {
      if (queue instanceof Queue) await queue.close();
    }
    this.redis?.disconnect();
  }
}
