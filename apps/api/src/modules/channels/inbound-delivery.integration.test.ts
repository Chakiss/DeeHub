/**
 * Inbound reservation delivery: OTA webhook → stored raw → mapped reservation.
 *
 * Covers the three rules from domain-model.md §3.8 — never drop a booking,
 * never refuse one, never create it twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import type { CredentialCipher } from '../../common/crypto/credential-cipher';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. Inbound delivery tests must run against Postgres.',
  );
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
process.env.REDIS_URL ??= 'redis://localhost:16379';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('inbound reservation delivery', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  let deliveryQueue: Queue;
  let relay: import('../outbox/outbox-relay.service').OutboxRelayService;
  let receiveWebhook: import('./application/receive-webhook.usecase').ReceiveWebhookUseCase;
  let deliverReservation: import('./application/deliver-reservation.usecase').DeliverReservationUseCase;
  let deliveryJobId: typeof import('../../queue/queues').deliveryJobId;

  const orgId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const channelId = crypto.randomUUID();

  const WEBHOOK_SECRET = 'inbound-test-secret';
  const EXTERNAL_ROOM = 'OTA-ROOM-1';
  const EXTERNAL_RATE = 'OTA-RATE-1';
  const DATES = ['2026-12-01', '2026-12-02', '2026-12-03'];

  function sign(body: string): string {
    return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  }

  function webhookBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      event: 'booking.created',
      booking: {
        bookingRef: 'OTA-BK-1',
        hotelCode: 'H1',
        roomId: EXTERNAL_ROOM,
        rateId: EXTERNAL_RATE,
        arrival: '20261201',
        departure: '20261203',
        adults: 2,
        children: 0,
        guestName: 'Inbound Guest',
        guestEmail: 'guest@example.com',
        totalPrice: '5000.00',
        currency: 'THB',
        status: 'CONFIRMED',
        ...overrides,
      },
    });
  }

  beforeAll(async () => {
    const { WorkerModule } = await import('../../worker.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { RESERVATION_DELIVERY_QUEUE, REDIS } = await import('../../queue/queue.module');
    const { CREDENTIAL_CIPHER } = await import('../../common/crypto/credential-cipher');
    deliveryJobId = (await import('../../queue/queues')).deliveryJobId;
    const { OutboxRelayService } = await import('../outbox/outbox-relay.service');
    const { ReceiveWebhookUseCase } = await import('./application/receive-webhook.usecase');
    const { DeliverReservationUseCase } = await import('./application/deliver-reservation.usecase');

    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();

    pool = moduleRef.get<Pool>(DATABASE_POOL);
    redis = moduleRef.get<Redis>(REDIS);
    deliveryQueue = moduleRef.get<Queue>(RESERVATION_DELIVERY_QUEUE);
    relay = moduleRef.get(OutboxRelayService);
    receiveWebhook = moduleRef.get(ReceiveWebhookUseCase);
    deliverReservation = moduleRef.get(DeliverReservationUseCase);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      orgId,
      'Inbound Test Org',
      `inbound-${orgId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency)
       VALUES ($1, $2, 'IN1', 'Inbound Test', 'Asia/Bangkok', 'THB')`,
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

    const cipher = moduleRef.get<CredentialCipher>(CREDENTIAL_CIPHER);
    await pool.query(
      `INSERT INTO channels (id, organization_id, property_id, type, name, status, credentials_encrypted)
       VALUES ($1, $2, $3, 'MOCK_OTA', 'Mock OTA', 'ACTIVE', $4)`,
      [
        channelId,
        orgId,
        propertyId,
        cipher.encrypt({
          baseUrl: 'http://127.0.0.1:45999',
          apiKey: 'k',
          hotelCode: 'H1',
          webhookSecret: WEBHOOK_SECRET,
        }),
      ],
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
    await deliveryQueue.obliterate({ force: true }).catch(() => undefined);
    for (const table of [
      'outbox_events',
      'audit_logs',
      'channel_reservations',
      'reservations',
      'guests',
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

  async function reset(allotment = 5): Promise<void> {
    await pool.query('DELETE FROM outbox_events');
    await pool.query('DELETE FROM channel_reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    await deliveryQueue.obliterate({ force: true }).catch(() => undefined);

    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [orgId, propertyId, roomTypeId, date, allotment],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 250000, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy],
        );
      }
    }
  }

  async function storedBooking(): Promise<{ id: string; status: string; error: string | null }> {
    const rows = await pool.query<{ id: string; status: string; error: string | null }>(
      'SELECT id, status, error FROM channel_reservations WHERE organization_id = $1 LIMIT 1',
      [orgId],
    );
    return rows.rows[0]!;
  }

  async function bookedOn(date: string): Promise<number> {
    const rows = await pool.query<{ booked: number; allotment: number }>(
      'SELECT booked, allotment FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [roomTypeId, date],
    );
    return rows.rows[0]?.booked ?? -1;
  }

  beforeEach(async () => {
    await reset();
  });

  describe('webhook receipt', () => {
    it('stores a signed booking and queues it, without mapping inline', async () => {
      const body = webhookBody();
      const result = await receiveWebhook.execute({
        channelId,
        rawBody: body,
        signature: sign(body),
      });

      expect(result).toEqual({ received: 1, duplicates: 0, quarantined: 0 });

      const stored = await storedBooking();
      expect(stored.status).toBe('RECEIVED');
      // No reservation yet: mapping is the worker's job.
      const reservations = await pool.query(
        'SELECT 1 FROM reservations WHERE organization_id = $1',
        [orgId],
      );
      expect(reservations.rowCount).toBe(0);
    });

    it('rejects a bad signature before parsing', async () => {
      await expect(
        receiveWebhook.execute({ channelId, rawBody: webhookBody(), signature: 'wrong' }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      const stored = await pool.query(
        'SELECT 1 FROM channel_reservations WHERE organization_id = $1',
        [orgId],
      );
      expect(stored.rowCount).toBe(0);
    });

    it('treats redelivery as a no-op instead of a double booking', async () => {
      const body = webhookBody();
      const first = await receiveWebhook.execute({
        channelId,
        rawBody: body,
        signature: sign(body),
      });
      const second = await receiveWebhook.execute({
        channelId,
        rawBody: body,
        signature: sign(body),
      });

      expect(first).toEqual({ received: 1, duplicates: 0, quarantined: 0 });
      // The unique dedupe index absorbed it.
      expect(second).toEqual({ received: 0, duplicates: 1, quarantined: 0 });

      const count = await pool.query(
        'SELECT 1 FROM channel_reservations WHERE organization_id = $1',
        [orgId],
      );
      expect(count.rowCount).toBe(1);
    });

    it('emits an event the relay turns into a delivery job', async () => {
      const body = webhookBody();
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });

      expect(await relay.drainOnce()).toBe(1);

      const stored = await storedBooking();
      const job = await deliveryQueue.getJob(deliveryJobId(stored.id));
      expect(job?.data).toMatchObject({ channelReservationId: stored.id });
    });
  });

  describe('mapping to a reservation', () => {
    async function receiveAndDeliver(overrides: Record<string, unknown> = {}) {
      const body = webhookBody(overrides);
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const stored = await storedBooking();
      return deliverReservation.execute({ channelReservationId: stored.id });
    }

    it('creates a confirmed reservation and holds inventory', async () => {
      const outcome = await receiveAndDeliver();

      expect(outcome.status).toBe('PROCESSED');
      expect(await bookedOn('2026-12-01')).toBe(1);
      expect(await bookedOn('2026-12-02')).toBe(1);
      // The departure date is not a night.
      expect(await bookedOn('2026-12-03')).toBe(0);

      const reservation = await pool.query<{ status: string; source: string; booker_name: string }>(
        'SELECT status, source, booker_name FROM reservations WHERE organization_id = $1',
        [orgId],
      );
      expect(reservation.rows[0]).toMatchObject({
        status: 'CONFIRMED',
        source: 'OTA',
        booker_name: 'Inbound Guest',
      });
    });

    it('marks the stored booking PROCESSED and links the reservation', async () => {
      const outcome = await receiveAndDeliver();
      const stored = await storedBooking();
      expect(stored.status).toBe('PROCESSED');

      const link = await pool.query<{ reservation_id: string }>(
        'SELECT reservation_id FROM channel_reservations WHERE id = $1',
        [stored.id],
      );
      expect(link.rows[0]?.reservation_id).toBe(
        outcome.status === 'PROCESSED' ? outcome.reservationId : null,
      );
    });

    it('is idempotent: redelivering the same job does not double-book', async () => {
      await receiveAndDeliver();
      const stored = await storedBooking();

      const again = await deliverReservation.execute({ channelReservationId: stored.id });
      expect(again.status).toBe('ALREADY_PROCESSED');
      expect(await bookedOn('2026-12-01')).toBe(1);
    });

    it('falls back to a room-type rate plan when the OTA omits the rate id', async () => {
      const outcome = await receiveAndDeliver({ rateId: null });
      expect(outcome.status).toBe('PROCESSED');
    });
  });

  describe('never drop a booking', () => {
    it('records an unmapped room type as FAILED with the raw payload intact', async () => {
      const body = webhookBody({ roomId: 'UNKNOWN-ROOM' });
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const stored = await storedBooking();

      const outcome = await deliverReservation.execute({ channelReservationId: stored.id });
      expect(outcome.status).toBe('FAILED');

      const row = await pool.query<{ status: string; error: string; raw_payload: unknown }>(
        'SELECT status, error, raw_payload FROM channel_reservations WHERE id = $1',
        [stored.id],
      );
      expect(row.rows[0]?.status).toBe('FAILED');
      expect(row.rows[0]?.error).toContain('mapping');
      // Kept verbatim so staff can add the mapping and reprocess.
      expect(row.rows[0]?.raw_payload).toBeDefined();
      expect(JSON.stringify(row.rows[0]?.raw_payload)).toContain('UNKNOWN-ROOM');
    });

    it('quarantines an authentic but unparseable payload instead of discarding it', async () => {
      // The signature is valid, so this really came from the OTA — we just
      // cannot read it. Rejecting at the door would strand a real guest.
      const body = webhookBody({ arrival: '20261232' });
      const result = await receiveWebhook.execute({
        channelId,
        rawBody: body,
        signature: sign(body),
      });

      expect(result).toEqual({ received: 0, duplicates: 0, quarantined: 1 });

      const stored = await storedBooking();
      expect(stored.status).toBe('FAILED');
      expect(stored.error).toContain('invalid date');
      // The raw bytes survive for staff to inspect and reprocess.
      const raw = await pool.query<{ raw_payload: { rawBody?: string } }>(
        'SELECT raw_payload FROM channel_reservations WHERE id = $1',
        [stored.id],
      );
      expect(raw.rows[0]?.raw_payload.rawBody).toContain('20261232');
    });

    it('deduplicates a redelivered unparseable payload', async () => {
      const body = webhookBody({ arrival: '20261232' });
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const second = await receiveWebhook.execute({
        channelId,
        rawBody: body,
        signature: sign(body),
      });
      expect(second.quarantined).toBe(0);

      const count = await pool.query(
        'SELECT 1 FROM channel_reservations WHERE organization_id = $1',
        [orgId],
      );
      expect(count.rowCount).toBe(1);
    });
  });

  describe('never refuse a booking the channel already sold', () => {
    it('absorbs an oversell by raising allotment and alerting', async () => {
      // The hotel has one room left; the OTA sold two before our push landed.
      await reset(1);
      await pool.query(
        'UPDATE inventory_days SET booked = 1 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2026-12-01'],
      );

      const body = webhookBody();
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const stored = await storedBooking();
      const outcome = await deliverReservation.execute({ channelReservationId: stored.id });

      // Accepted, not rejected: the guest holds a confirmation.
      expect(outcome).toMatchObject({ status: 'PROCESSED', overbooked: true });

      const day = await pool.query<{ allotment: number; booked: number }>(
        'SELECT allotment, booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2026-12-01'],
      );
      // Allotment was raised so the oversell is visible in the data and
      // reconciliation still balances.
      expect(day.rows[0]).toMatchObject({ allotment: 2, booked: 2 });
    });

    it('raises an overbooking alert event for staff', async () => {
      await reset(1);
      await pool.query(
        'UPDATE inventory_days SET booked = 1 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2026-12-01'],
      );

      const body = webhookBody();
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const stored = await storedBooking();
      await deliverReservation.execute({ channelReservationId: stored.id });

      const events = await pool.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_events WHERE organization_id = $1',
        [orgId],
      );
      expect(events.rows.map((row) => row.event_type)).toContain('channel.overbooking_detected');
    });

    it('accepts a booking for a night that was never opened for sale', async () => {
      await pool.query('DELETE FROM inventory_days WHERE room_type_id = $1 AND date = $2', [
        roomTypeId,
        '2026-12-02',
      ]);

      const body = webhookBody();
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const stored = await storedBooking();
      const outcome = await deliverReservation.execute({ channelReservationId: stored.id });

      expect(outcome).toMatchObject({ status: 'PROCESSED', overbooked: true });
      // The missing night was created with exactly enough capacity.
      expect(await bookedOn('2026-12-02')).toBe(1);
    });

    it('accepts despite a stop-sell and reports the override', async () => {
      await pool.query(
        'UPDATE inventory_days SET stop_sell = true WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2026-12-01'],
      );

      const body = webhookBody();
      await receiveWebhook.execute({ channelId, rawBody: body, signature: sign(body) });
      const stored = await storedBooking();
      const outcome = await deliverReservation.execute({ channelReservationId: stored.id });

      expect(outcome).toMatchObject({ status: 'PROCESSED', overbooked: true });
      expect(await bookedOn('2026-12-01')).toBe(1);
    });

    it('leaves the DIRECT booking path strict', async () => {
      // Regression guard: the relaxed policy must never leak into a path the
      // hotel controls, where the overbooking guard is the whole point.
      const { CreateReservationUseCase } =
        await import('../reservations/application/create-reservation.usecase');
      const { runWithTenant } = await import('../../common/tenant/tenant-context');
      const createReservation = moduleRef.get(CreateReservationUseCase);

      await reset(0);

      await expect(
        runWithTenant(
          { organizationId: orgId, userId: null, propertyId, requestId: 'strict' },
          () =>
            createReservation.execute(
              {
                propertyId,
                source: 'DIRECT',
                booker: { name: 'Walk In' },
                stays: [
                  {
                    roomTypeId,
                    ratePlanId,
                    checkIn: '2026-12-01' as never,
                    checkOut: '2026-12-02' as never,
                    adults: 2,
                  },
                ],
              },
              { type: 'USER', id: null, label: 'test' },
            ),
        ),
      ).rejects.toMatchObject({ code: 'INVENTORY_UNAVAILABLE' });
    });
  });
});
