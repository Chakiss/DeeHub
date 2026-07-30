/**
 * Worker integration: outbox relay, hold expiry and reconciliation against
 * real PostgreSQL and real Redis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Worker tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
process.env.REDIS_URL ??= 'redis://localhost:16379';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('worker', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  let ariQueue: Queue;
  let relay: import('./outbox-relay.service').OutboxRelayService;
  let expireHolds: import('../inventory/application/expire-holds.usecase').ExpireHoldsUseCase;
  let reconcile: import('../inventory/application/reconcile-inventory.usecase').ReconcileInventoryUseCase;
  let ariDirtyKey: typeof import('../../queue/queues').ariDirtyKey;
  let ariJobId: typeof import('../../queue/queues').ariJobId;

  const orgId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const channelId = crypto.randomUUID();

  const DATES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];

  beforeAll(async () => {
    const { WorkerModule } = await import('../../worker.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { ARI_SYNC_QUEUE, REDIS } = await import('../../queue/queue.module');
    const { OutboxRelayService } = await import('./outbox-relay.service');
    const { ExpireHoldsUseCase } = await import('../inventory/application/expire-holds.usecase');
    const { ReconcileInventoryUseCase } =
      await import('../inventory/application/reconcile-inventory.usecase');
    const queues = await import('../../queue/queues');
    ariDirtyKey = queues.ariDirtyKey;
    ariJobId = queues.ariJobId;

    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();

    pool = moduleRef.get<Pool>(DATABASE_POOL);
    redis = moduleRef.get<Redis>(REDIS);
    ariQueue = moduleRef.get<Queue>(ARI_SYNC_QUEUE);
    relay = moduleRef.get(OutboxRelayService);
    expireHolds = moduleRef.get(ExpireHoldsUseCase);
    reconcile = moduleRef.get(ReconcileInventoryUseCase);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      orgId,
      'Worker Test Org',
      `worker-${orgId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency)
       VALUES ($1, $2, 'WT1', 'Worker Test', 'Asia/Bangkok', 'THB')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe')`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'BAR')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );
  });

  afterAll(async () => {
    await ariQueue.obliterate({ force: true }).catch(() => undefined);
    await redis.del(ariDirtyKey(channelId, roomTypeId));
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM guests WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM channels WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_plans WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM room_types WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM properties WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await moduleRef.close();
  });

  async function reset(options: { activeChannel?: boolean } = {}): Promise<void> {
    // The relay is a SYSTEM process: it drains every tenant's events, not just
    // ours. Counting published rows is therefore only meaningful if this test
    // owns the whole table — scoping the cleanup to our organization would let
    // stray rows from a dev database inflate the count.
    await pool.query('DELETE FROM outbox_events');
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM guests WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM channels WHERE organization_id = $1', [orgId]);
    await ariQueue.obliterate({ force: true }).catch(() => undefined);
    await redis.del(ariDirtyKey(channelId, roomTypeId));

    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 5, 0)`,
        [orgId, propertyId, roomTypeId, date],
      );
    }

    if (options.activeChannel !== false) {
      await pool.query(
        `INSERT INTO channels (id, organization_id, property_id, type, name, status)
         VALUES ($1, $2, $3, 'MOCK_OTA', 'Mock OTA', 'ACTIVE')`,
        [channelId, orgId, propertyId],
      );
    }
  }

  async function insertInventoryChanged(from: string, to: string): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (id, organization_id, property_id, aggregate_type, aggregate_id,
                                  event_type, payload)
       VALUES ($1, $2, $3, 'inventory', $4, 'inventory.changed', $5::jsonb)`,
      [
        id,
        orgId,
        propertyId,
        roomTypeId,
        JSON.stringify({ propertyId, roomTypeId, from, to, reason: 'BOOKED_CHANGED' }),
      ],
    );
    return id;
  }

  async function unpublishedCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM outbox_events WHERE organization_id = $1 AND published_at IS NULL',
      [orgId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  describe('outbox relay', () => {
    beforeEach(async () => {
      await reset();
    });

    it('publishes an inventory event and queues a debounced ARI push', async () => {
      await insertInventoryChanged('2026-10-01', '2026-10-03');

      const published = await relay.drainOnce();

      expect(published).toBe(1);
      expect(await unpublishedCount()).toBe(0);

      // Dates marked dirty, including both ends of the span.
      const dirty = await redis.smembers(ariDirtyKey(channelId, roomTypeId));
      expect(dirty.sort()).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);

      // One delayed job, keyed so repeats coalesce into it.
      const job = await ariQueue.getJob(ariJobId(channelId, roomTypeId));
      expect(job).toBeDefined();
      expect(job?.data).toMatchObject({ channelId, roomTypeId, propertyId });
    });

    it('coalesces a burst of edits into ONE queued job', async () => {
      // Ten separate bookings on overlapping dates must not become ten pushes.
      for (let i = 0; i < 10; i += 1) {
        await insertInventoryChanged('2026-10-01', '2026-10-02');
      }

      expect(await relay.drainOnce()).toBe(10);

      const counts = await ariQueue.getJobCounts();
      const queued = (counts['delayed'] ?? 0) + (counts['waiting'] ?? 0) + (counts['active'] ?? 0);
      expect(queued).toBe(1);
    });

    it('accumulates dirty dates across events into the same job', async () => {
      await insertInventoryChanged('2026-10-01', '2026-10-01');
      await insertInventoryChanged('2026-10-04', '2026-10-04');
      await relay.drainOnce();

      const dirty = await redis.smembers(ariDirtyKey(channelId, roomTypeId));
      expect(dirty.sort()).toEqual(['2026-10-01', '2026-10-04']);
    });

    it('consumes the event when the property has no active channel', async () => {
      await reset({ activeChannel: false });
      await insertInventoryChanged('2026-10-01', '2026-10-02');

      expect(await relay.drainOnce()).toBe(1);
      expect(await unpublishedCount()).toBe(0);
      // A direct-only hotel is not an error; there is simply nowhere to push.
      const counts = await ariQueue.getJobCounts();
      expect((counts['delayed'] ?? 0) + (counts['waiting'] ?? 0)).toBe(0);
    });

    it('ignores an inactive channel', async () => {
      await pool.query('UPDATE channels SET status = $1 WHERE id = $2', ['INACTIVE', channelId]);
      await insertInventoryChanged('2026-10-01', '2026-10-02');

      await relay.drainOnce();
      expect(await redis.smembers(ariDirtyKey(channelId, roomTypeId))).toEqual([]);
    });

    it('publishes reservation events without queuing an ARI push', async () => {
      await pool.query(
        `INSERT INTO outbox_events (id, organization_id, property_id, aggregate_type, aggregate_id,
                                    event_type, payload)
         VALUES ($1, $2, $3, 'reservation', $4, 'reservation.created', '{}'::jsonb)`,
        [crypto.randomUUID(), orgId, propertyId, crypto.randomUUID()],
      );

      expect(await relay.drainOnce()).toBe(1);
      expect(await unpublishedCount()).toBe(0);
    });

    it('returns 0 and does nothing when the outbox is empty', async () => {
      expect(await relay.drainOnce()).toBe(0);
    });

    it('does not republish an already published event', async () => {
      await insertInventoryChanged('2026-10-01', '2026-10-02');
      expect(await relay.drainOnce()).toBe(1);
      expect(await relay.drainOnce()).toBe(0);
    });

    it('lets concurrent relays split the batch without double publishing', async () => {
      // SKIP LOCKED is what allows several worker instances to run at once.
      for (let i = 0; i < 6; i += 1) {
        await insertInventoryChanged('2026-10-01', '2026-10-02');
      }

      const [a, b] = await Promise.all([relay.drainOnce(), relay.drainOnce()]);

      expect(a + b).toBe(6);
      expect(await unpublishedCount()).toBe(0);
    });

    it('still queues a push AFTER a previous job for the same key completed', async () => {
      // Regression: the ARI queue debounces with a deterministic jobId, and
      // BullMQ ignores `add` while a job with that id exists — including a
      // COMPLETED one. Retaining completed jobs silently blocked every later
      // change for that room type, so the OTA kept selling stale availability
      // with no error anywhere. Completed jobs are now removed immediately.
      const { Worker } = await import('bullmq');

      await insertInventoryChanged('2026-10-01', '2026-10-02');
      await relay.drainOnce();

      // Run a real worker so the job genuinely completes and is removed.
      const processed: string[] = [];
      const worker = new Worker(
        ariQueue.name,
        async (job) => {
          processed.push(String(job.id));
          await redis.del(ariDirtyKey(channelId, roomTypeId));
          return { ok: true };
        },
        { connection: redis, concurrency: 1 },
      );

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('job never completed')), 15_000);
          worker.on('completed', () => {
            clearTimeout(timer);
            resolve();
          });
          worker.on('failed', (_job, error) => {
            clearTimeout(timer);
            reject(error);
          });
        });

        // A second change arrives after the first push finished.
        await insertInventoryChanged('2026-10-03', '2026-10-04');
        expect(await relay.drainOnce()).toBe(1);

        const job = await ariQueue.getJob(ariJobId(channelId, roomTypeId));
        expect(job, 'a new job must be queued once the previous one completed').toBeDefined();
        expect(await redis.smembers(ariDirtyKey(channelId, roomTypeId))).toContain('2026-10-03');
      } finally {
        await worker.close();
      }
    });

    it('records the error and leaves the row unpublished when a payload is malformed', async () => {
      await pool.query(
        `INSERT INTO outbox_events (id, organization_id, property_id, aggregate_type, aggregate_id,
                                    event_type, payload)
         VALUES ($1, $2, $3, 'inventory', $4, 'inventory.changed', '{"bogus": true}'::jsonb)`,
        [crypto.randomUUID(), orgId, propertyId, roomTypeId],
      );
      await insertInventoryChanged('2026-10-01', '2026-10-02');

      // The good event still goes out: one bad row must not block the queue.
      expect(await relay.drainOnce()).toBe(1);

      const failed = await pool.query<{ attempts: number; last_error: string }>(
        `SELECT attempts, last_error FROM outbox_events
          WHERE organization_id = $1 AND published_at IS NULL`,
        [orgId],
      );
      expect(failed.rows).toHaveLength(1);
      expect(failed.rows[0]?.attempts).toBe(1);
      expect(failed.rows[0]?.last_error).toContain('roomTypeId');
    });
  });

  describe('hold expiry', () => {
    async function createHold(expiresAt: Date, status = 'PENDING'): Promise<string> {
      const reservationId = crypto.randomUUID();
      const stayId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO reservations (id, organization_id, property_id, code, status, source,
                                   booker_name, currency, hold_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'DIRECT', 'Hold Tester', 'THB', $6)`,
        [
          reservationId,
          orgId,
          propertyId,
          `DH-${reservationId.slice(0, 6).toUpperCase()}`,
          status,
          expiresAt,
        ],
      );
      await pool.query(
        `INSERT INTO reservation_stays (id, organization_id, property_id, reservation_id,
                                        room_type_id, rate_plan_id, check_in, check_out, adults)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-10-01', '2026-10-03', 2)`,
        [stayId, orgId, propertyId, reservationId, roomTypeId, ratePlanId],
      );
      for (const date of ['2026-10-01', '2026-10-02']) {
        await pool.query(
          `INSERT INTO reservation_stay_nights (stay_id, date, organization_id, reservation_id,
                                                property_id, room_type_id, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 250000, 'THB')`,
          [stayId, date, orgId, reservationId, propertyId, roomTypeId],
        );
        await pool.query(
          'UPDATE inventory_days SET booked = booked + 1 WHERE room_type_id = $1 AND date = $2',
          [roomTypeId, date],
        );
      }
      return reservationId;
    }

    async function bookedOn(date: string): Promise<number> {
      const result = await pool.query<{ booked: number }>(
        'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, date],
      );
      return result.rows[0]?.booked ?? -1;
    }

    beforeEach(async () => {
      await reset();
    });

    it('expires a lapsed hold and returns its nights to the pool', async () => {
      const reservationId = await createHold(new Date(Date.now() - 60_000));
      expect(await bookedOn('2026-10-01')).toBe(1);

      const result = await expireHolds.execute();

      expect(result).toEqual({ expired: 1, nightsReleased: 2 });
      expect(await bookedOn('2026-10-01')).toBe(0);
      expect(await bookedOn('2026-10-02')).toBe(0);

      const status = await pool.query<{ status: string }>(
        'SELECT status FROM reservations WHERE id = $1',
        [reservationId],
      );
      expect(status.rows[0]?.status).toBe('EXPIRED');
    });

    it('leaves a hold that has not lapsed alone', async () => {
      await createHold(new Date(Date.now() + 600_000));
      expect(await expireHolds.execute()).toEqual({ expired: 0, nightsReleased: 0 });
      expect(await bookedOn('2026-10-01')).toBe(1);
    });

    it('never touches a CONFIRMED reservation, even with a stale hold timestamp', async () => {
      // The guest paid; the sweeper must not take the room back.
      await createHold(new Date(Date.now() - 60_000), 'CONFIRMED');
      expect(await expireHolds.execute()).toEqual({ expired: 0, nightsReleased: 0 });
      expect(await bookedOn('2026-10-01')).toBe(1);
    });

    it('emits inventory and status events so the OTAs learn the room is free', async () => {
      await createHold(new Date(Date.now() - 60_000));
      await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);

      await expireHolds.execute();

      const events = await pool.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_events WHERE organization_id = $1',
        [orgId],
      );
      const types = events.rows.map((row) => row.event_type);
      expect(types).toContain('inventory.changed');
      expect(types).toContain('reservation.status_changed');
    });

    it('writes an audit entry attributed to the system', async () => {
      const reservationId = await createHold(new Date(Date.now() - 60_000));
      await expireHolds.execute();

      const audit = await pool.query<{ action: string; actor_type: string }>(
        'SELECT action, actor_type FROM audit_logs WHERE entity_id = $1',
        [reservationId],
      );
      expect(audit.rows[0]?.action).toBe('reservation.hold_expired');
      expect(audit.rows[0]?.actor_type).toBe('SYSTEM');
    });

    it('is idempotent: a second sweep finds nothing', async () => {
      await createHold(new Date(Date.now() - 60_000));
      await expireHolds.execute();
      expect(await expireHolds.execute()).toEqual({ expired: 0, nightsReleased: 0 });
      expect(await bookedOn('2026-10-01')).toBe(0);
    });

    it('expires several holds in one pass', async () => {
      await createHold(new Date(Date.now() - 60_000));
      await createHold(new Date(Date.now() - 30_000));
      const result = await expireHolds.execute();
      expect(result.expired).toBe(2);
      expect(await bookedOn('2026-10-01')).toBe(0);
    });
  });

  describe('reconciliation', () => {
    beforeEach(async () => {
      await reset();
    });

    it('reports no drift when booked matches the reservations', async () => {
      const result = await reconcile.execute();
      // Reconciliation is a SYSTEM process that scans every tenant, so assert
      // about this property only — a shared dev database may legitimately hold
      // other rows.
      expect(result.drift.filter((row) => row.propertyId === propertyId)).toEqual([]);
      expect(result.checked).toBeGreaterThan(0);
    });

    it('detects booked higher than the reservations imply', async () => {
      // Simulates a release that never happened — the failure mode that would
      // silently strand inventory.
      await pool.query(
        'UPDATE inventory_days SET booked = 2 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, DATES[0]],
      );

      const result = await reconcile.execute();
      const drift = result.drift.find((row) => row.roomTypeId === roomTypeId);
      expect(drift).toMatchObject({ actual: 2, expected: 0 });
    });

    it('does not repair the drift it finds', async () => {
      // Reporting, not repairing: auto-correcting would hide the bug that
      // caused it, and the next occurrence could be an overbooking.
      await pool.query(
        'UPDATE inventory_days SET booked = 3 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, DATES[1]],
      );
      await reconcile.execute();

      const after = await pool.query<{ booked: number }>(
        'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, DATES[1]],
      );
      expect(after.rows[0]?.booked).toBe(3);
    });
  });
});
