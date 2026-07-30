/**
 * The Phase 2 milestone proof: a booking in DeeHub changes what the OTA sells.
 *
 * Runs the whole chain — reservation use case, transactional outbox, relay,
 * connector registry, HTTP push — against real PostgreSQL, real Redis and a
 * real (mock) OTA server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { toIsoDate, type IsoDate } from '@deehub/shared';
import { MockOta } from '@deehub/mock-ota';
import type { CredentialCipher as CredentialCipherType } from '../../common/crypto/credential-cipher';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Sync engine tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
process.env.REDIS_URL ??= 'redis://localhost:16379';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('sync engine end to end', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  let ariQueue: Queue;
  let ota: MockOta;
  let relay: import('../outbox/outbox-relay.service').OutboxRelayService;
  let pushAri: import('./application/push-ari.usecase').PushAriUseCase;
  let createReservation: import('../reservations/application/create-reservation.usecase').CreateReservationUseCase;
  let runWithTenant: typeof import('../../common/tenant/tenant-context').runWithTenant;
  let ariDirtyKey: typeof import('../../queue/queues').ariDirtyKey;

  const orgId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const channelId = crypto.randomUUID();

  const HOTEL_CODE = 'DEEHUB-1';
  const EXTERNAL_ROOM = 'OTA-ROOM-DLX';
  const EXTERNAL_RATE = 'OTA-RATE-BAR';
  const DATES = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
  const ALLOTMENT = 4;

  const actor = { type: 'USER' as const, id: null, label: 'sync-test' };

  /** Working credentials, restored by reset() so one failure test cannot leak. */
  let goodCredentials: Buffer;
  let cipher: CredentialCipherType;

  function tenant() {
    return { organizationId: orgId, userId: null, propertyId, requestId: 'sync-test' };
  }

  beforeAll(async () => {
    const { WorkerModule } = await import('../../worker.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { ARI_SYNC_QUEUE, REDIS } = await import('../../queue/queue.module');
    const { CREDENTIAL_CIPHER } = await import('../../common/crypto/credential-cipher');
    const { OutboxRelayService } = await import('../outbox/outbox-relay.service');
    const { PushAriUseCase } = await import('./application/push-ari.usecase');
    const { CreateReservationUseCase } =
      await import('../reservations/application/create-reservation.usecase');
    const tenantContext = await import('../../common/tenant/tenant-context');
    runWithTenant = tenantContext.runWithTenant;
    ariDirtyKey = (await import('../../queue/queues')).ariDirtyKey;

    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();

    pool = moduleRef.get<Pool>(DATABASE_POOL);
    redis = moduleRef.get<Redis>(REDIS);
    ariQueue = moduleRef.get<Queue>(ARI_SYNC_QUEUE);
    relay = moduleRef.get(OutboxRelayService);
    pushAri = moduleRef.get(PushAriUseCase);
    createReservation = moduleRef.get(CreateReservationUseCase);

    ota = new MockOta({ apiKey: 'sync-test-key', webhookSecret: 'sync-test-secret' });
    const port = await ota.listen(0);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      orgId,
      'Sync Test Org',
      `sync-${orgId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency)
       VALUES ($1, $2, 'SYNC1', 'Sync Test Property', 'Asia/Bangkok', 'THB')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name, max_occupancy, max_adults)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 3, 3)`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'BAR')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );

    // Credentials go in encrypted, exactly as the API would store them.
    cipher = moduleRef.get<CredentialCipherType>(CREDENTIAL_CIPHER);
    goodCredentials = cipher.encrypt({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: 'sync-test-key',
      hotelCode: HOTEL_CODE,
      webhookSecret: 'sync-test-secret',
    });
    const credentials = goodCredentials;

    await pool.query(
      `INSERT INTO channels (id, organization_id, property_id, type, name, status, credentials_encrypted)
       VALUES ($1, $2, $3, 'MOCK_OTA', 'Mock OTA', 'ACTIVE', $4)`,
      [channelId, orgId, propertyId, credentials],
    );
    await pool.query(
      `INSERT INTO channel_room_type_mappings (id, organization_id, channel_id, room_type_id, external_room_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), orgId, channelId, roomTypeId, EXTERNAL_ROOM],
    );
    await pool.query(
      `INSERT INTO channel_rate_plan_mappings (id, organization_id, channel_id, rate_plan_id, external_rate_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), orgId, channelId, ratePlanId, EXTERNAL_RATE],
    );
  });

  afterAll(async () => {
    await ota.close();
    await ariQueue.obliterate({ force: true }).catch(() => undefined);
    await redis.del(ariDirtyKey(channelId, roomTypeId));
    for (const table of [
      'outbox_events',
      'audit_logs',
      'sync_jobs',
      'reservations',
      'inventory_days',
      'rate_days',
      'channel_rate_plan_mappings',
      'channel_room_type_mappings',
      'channels',
      'rate_plans',
      'room_types',
      'properties',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await moduleRef.close();
  });

  async function reset(): Promise<void> {
    await pool.query('DELETE FROM outbox_events');
    await pool.query('DELETE FROM sync_jobs WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    // Restore working credentials: the failure test below points the channel at
    // a dead port, and without this every later test would inherit it.
    await pool.query(
      `UPDATE channels SET status = 'ACTIVE', last_error = NULL, last_sync_at = NULL,
                           credentials_encrypted = $2
        WHERE id = $1`,
      [channelId, goodCredentials],
    );
    await ariQueue.obliterate({ force: true }).catch(() => undefined);
    await redis.del(ariDirtyKey(channelId, roomTypeId));
    ota.reset();

    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [orgId, propertyId, roomTypeId, date, ALLOTMENT],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy, occupancy === 1 ? 200000 : 250000],
        );
      }
    }
  }

  /** Drain the dirty set the way the worker job does. */
  async function runPushJob(): Promise<void> {
    const key = ariDirtyKey(channelId, roomTypeId);
    const dates = await redis.smembers(key);
    await redis.del(key);
    if (dates.length === 0) return;
    await pushAri.execute({
      channelId,
      roomTypeId,
      dates: [...dates].sort().map((d) => toIsoDate(d)),
    });
  }

  beforeEach(async () => {
    await reset();
  });

  it('pushes availability, rates and restrictions the OTA can sell from', async () => {
    await runWithTenant(tenant(), () =>
      pushAri.execute({
        channelId,
        roomTypeId,
        dates: DATES.map((d) => toIsoDate(d)) as IsoDate[],
      }),
    );

    const stored = ota.getAri(HOTEL_CODE, EXTERNAL_ROOM);
    expect(stored).toHaveLength(4);
    expect(stored[0]).toMatchObject({ date: '20261101', avail: ALLOTMENT, closed: false });
    // Both occupancy points, mapped to the channel's rate id.
    expect(stored[0]?.rates).toEqual(
      expect.arrayContaining([
        { rateId: EXTERNAL_RATE, occupancy: 1, price: '2000.00', currency: 'THB' },
        { rateId: EXTERNAL_RATE, occupancy: 2, price: '2500.00', currency: 'THB' },
      ]),
    );
  });

  it('reduces what the OTA can sell after a booking — the milestone behaviour', async () => {
    // 1. Availability is published.
    await runWithTenant(tenant(), () =>
      pushAri.execute({ channelId, roomTypeId, dates: DATES.map((d) => toIsoDate(d)) }),
    );
    expect(ota.getAri(HOTEL_CODE, EXTERNAL_ROOM)[0]?.avail).toBe(4);

    // 2. A guest books two of the four rooms for the first two nights.
    await runWithTenant(tenant(), () =>
      createReservation.execute(
        {
          propertyId,
          source: 'DIRECT',
          booker: { name: 'Sync Test Guest' },
          stays: [
            {
              roomTypeId,
              ratePlanId,
              checkIn: toIsoDate('2026-11-01'),
              checkOut: toIsoDate('2026-11-03'),
              adults: 2,
            },
            {
              roomTypeId,
              ratePlanId,
              checkIn: toIsoDate('2026-11-01'),
              checkOut: toIsoDate('2026-11-03'),
              adults: 2,
            },
          ],
        },
        actor,
      ),
    );

    // 3. The relay publishes the inventory event and marks the dates dirty.
    expect(await relay.drainOnce()).toBeGreaterThan(0);

    // 4. The worker job pushes the new state.
    await runPushJob();

    const stored = ota.getAri(HOTEL_CODE, EXTERNAL_ROOM);
    const byDate = new Map(stored.map((row) => [row.date, row]));
    // Two rooms sold on the booked nights; the rest untouched.
    expect(byDate.get('20261101')?.avail).toBe(2);
    expect(byDate.get('20261102')?.avail).toBe(2);
    expect(byDate.get('20261103')?.avail).toBe(4);
  });

  it('records a successful sync job and refreshes channel health', async () => {
    await runWithTenant(tenant(), () =>
      pushAri.execute({ channelId, roomTypeId, dates: [toIsoDate(DATES[0]!)] }),
    );

    const job = await pool.query<{ status: string; kind: string }>(
      'SELECT status, kind FROM sync_jobs WHERE channel_id = $1',
      [channelId],
    );
    expect(job.rows[0]).toMatchObject({ status: 'SUCCEEDED', kind: 'ARI_PUSH' });

    const channel = await pool.query<{ last_sync_at: Date | null; last_error: string | null }>(
      'SELECT last_sync_at, last_error FROM channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]?.last_sync_at).toBeInstanceOf(Date);
    expect(channel.rows[0]?.last_error).toBeNull();
  });

  it('marks the channel ERRORED and does NOT advance last_sync_at when a push fails', async () => {
    // Point the channel at a closed port: the OTA is down. (Port 1 would be
    // rejected by fetch's blocked-port list before a connection is attempted,
    // which would test the wrong thing.)
    await pool.query('UPDATE channels SET credentials_encrypted = $1 WHERE id = $2', [
      cipher.encrypt({
        baseUrl: 'http://127.0.0.1:45999',
        apiKey: 'sync-test-key',
        hotelCode: HOTEL_CODE,
        webhookSecret: 'x',
      }),
      channelId,
    ]);

    await expect(
      runWithTenant(tenant(), () =>
        pushAri.execute({ channelId, roomTypeId, dates: [toIsoDate(DATES[0]!)] }),
      ),
    ).rejects.toThrow();

    const channel = await pool.query<{ status: string; last_sync_at: Date | null }>(
      'SELECT status, last_sync_at FROM channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]?.status).toBe('ERROR');
    // A failing channel must not look freshly synced — that blindness is what
    // lets stale availability keep selling.
    expect(channel.rows[0]?.last_sync_at).toBeNull();

    const job = await pool.query<{ status: string }>(
      'SELECT status FROM sync_jobs WHERE channel_id = $1',
      [channelId],
    );
    expect(job.rows[0]?.status).toBe('FAILED');
  });

  it('refuses to push an unmapped room type instead of guessing an identifier', async () => {
    const unmapped = crypto.randomUUID();
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'UNM', 'Unmapped')`,
      [unmapped, orgId, propertyId],
    );

    await expect(
      runWithTenant(tenant(), () =>
        pushAri.execute({ channelId, roomTypeId: unmapped, dates: [toIsoDate(DATES[0]!)] }),
      ),
    ).rejects.toMatchObject({ code: 'MAPPING_MISSING' });

    await pool.query('DELETE FROM room_types WHERE id = $1', [unmapped]);
  });

  it('sends zero and stop-sell for a night that was never opened', async () => {
    await pool.query('DELETE FROM inventory_days WHERE room_type_id = $1 AND date = $2', [
      roomTypeId,
      DATES[1],
    ]);

    await runWithTenant(tenant(), () =>
      pushAri.execute({ channelId, roomTypeId, dates: DATES.map((d) => toIsoDate(d)) }),
    );

    const closed = ota.getAri(HOTEL_CODE, EXTERNAL_ROOM).find((row) => row.date === '20261102');
    // Safe direction: never let the OTA sell a night we have no record of.
    expect(closed).toMatchObject({ avail: 0, closed: true });
  });

  it('propagates restrictions set by the hotel', async () => {
    await pool.query(
      `UPDATE inventory_days SET stop_sell = true, min_stay = 3, closed_to_arrival = true
        WHERE room_type_id = $1 AND date = $2`,
      [roomTypeId, DATES[0]],
    );

    await runWithTenant(tenant(), () =>
      pushAri.execute({ channelId, roomTypeId, dates: [toIsoDate(DATES[0]!)] }),
    );

    expect(ota.getAri(HOTEL_CODE, EXTERNAL_ROOM)[0]).toMatchObject({
      closed: true,
      minLos: 3,
      cta: true,
    });
  });

  it('pushes the whole current window, not just the changed night', async () => {
    await runWithTenant(tenant(), () =>
      pushAri.execute({ channelId, roomTypeId, dates: DATES.map((d) => toIsoDate(d)) }),
    );
    expect(ota.pushLog).toHaveLength(1);
    expect(ota.pushLog[0]?.nights).toBe(4);
  });

  it('is idempotent under the relay at-least-once guarantee', async () => {
    const dates = DATES.map((d) => toIsoDate(d));
    await runWithTenant(tenant(), () => pushAri.execute({ channelId, roomTypeId, dates }));
    await runWithTenant(tenant(), () => pushAri.execute({ channelId, roomTypeId, dates }));

    // Two deliveries of the same event produce identical OTA state.
    const stored = ota.getAri(HOTEL_CODE, EXTERNAL_ROOM);
    expect(stored).toHaveLength(4);
    expect(stored.every((row) => row.avail === ALLOTMENT)).toBe(true);
  });
});
