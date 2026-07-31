/**
 * Notifications end to end, against real PostgreSQL.
 *
 * Two halves that have to meet: the outbox relay turning a booking event into
 * stored messages, and the dispatcher turning stored messages into send
 * attempts. Both are exercised through the real HTTP booking path rather than
 * hand-written rows, because the thing most likely to break is the wiring
 * between them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';
import { NOTIFICATION_SENDERS } from './domain/notification-sender';
import type {
  NotificationSender,
  OutgoingMessage,
  SendOutcome,
} from './domain/notification-sender';
import type { NotificationChannel } from './domain/notification';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Notification tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

const NIGHTS = ['2032-03-01', '2032-03-02', '2032-03-03'] as const;
const RATE_MINOR = 150000;

/** A sender whose answer each test sets, so no test needs the network. */
class StubSender implements NotificationSender {
  outcome: SendOutcome = { status: 'SENT' };
  readonly sent: OutgoingMessage[] = [];

  constructor(readonly channel: NotificationChannel) {}

  send(message: OutgoingMessage): Promise<SendOutcome> {
    this.sent.push(message);
    return Promise.resolve(this.outcome);
  }
}

describeIfDb('Notifications', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let pool: Pool;
  let relay: import('../outbox/outbox-relay.service').OutboxRelayService;
  let dispatch: import('./application/dispatch-notifications.usecase').DispatchNotificationsUseCase;

  const email = new StubSender('EMAIL');
  const line = new StubSender('LINE');

  const PASSWORD = 'notify-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `nt-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  let token = '';

  beforeAll(async () => {
    const { AppModule } = await import('../../app.module');
    const { WorkerModule } = await import('../../worker.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { ScryptPasswordHasher } = await import('../auth/domain/password-hasher');
    const { OutboxRelayService } = await import('../outbox/outbox-relay.service');
    const { DispatchNotificationsUseCase } =
      await import('./application/dispatch-notifications.usecase');

    const httpRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = httpRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();

    // The relay and the dispatcher are worker-side. Same database, separate
    // context — which is also how they run in production.
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(NOTIFICATION_SENDERS)
      .useValue([email, line])
      .compile();
    await worker.init();

    relay = worker.get(OutboxRelayService);
    dispatch = worker.get(DispatchNotificationsUseCase);
    pool = httpRef.get<Pool>(DATABASE_POOL);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      orgId,
      orgSlug,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                               phone, email)
       VALUES ($1, $2, 'MAIN', 'Baan Suan', 'Asia/Bangkok', 'THB', 'TH',
               '+66 2 111 2222', 'desk@baansuan.test')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
       VALUES ($1, $2, 'ANNEX', 'Annex', 'Asia/Bangkok', 'THB', 'TH')`,
      [otherPropertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 2, 4, 3, 2)`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );
    // INACTIVE on purpose: an active channel makes the relay require Redis.
    await pool.query(
      `INSERT INTO channels (id, organization_id, property_id, type, name, status)
       VALUES ($1, $2, $3, 'MOCK_OTA', 'Agoda', 'INACTIVE')`,
      [channelId, orgId, propertyId],
    );

    const hash = await new ScryptPasswordHasher().hash(PASSWORD);
    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $3)`,
      [managerId, orgId, `manager-${orgSlug}@e2e.test`, hash],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
       VALUES ($1, $2, $3, NULL, 'MANAGER')`,
      [crypto.randomUUID(), orgId, managerId],
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email: `manager-${orgSlug}@e2e.test`, password: PASSWORD })
      .expect(200);
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    for (const table of [
      'notifications',
      'audit_logs',
      'outbox_events',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'channel_reservations',
      'sync_jobs',
      'channel_rate_plan_mappings',
      'channel_room_type_mappings',
      'channels',
      'rate_days',
      'inventory_days',
      'rate_plans',
      'room_types',
      'memberships',
      'refresh_tokens',
      'users',
      'properties',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    for (const table of [
      'notifications',
      'outbox_events',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'rate_days',
      'inventory_days',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    for (const date of NIGHTS) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 5)`,
        [orgId, propertyId, roomTypeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy, RATE_MINOR],
        );
      }
    }
    email.outcome = { status: 'SENT' };
    line.outcome = { status: 'SENT' };
    email.sent.length = 0;
    line.sent.length = 0;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function book(bookerEmail: string | null = 'guest@example.test') {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'PHONE',
        status: 'CONFIRMED',
        booker: {
          name: 'Naruemon Chaiyaporn',
          ...(bookerEmail ? { email: bookerEmail } : {}),
        },
        stays: [
          {
            roomTypeId,
            ratePlanId,
            checkIn: NIGHTS[0],
            checkOut: NIGHTS[2],
            adults: 2,
          },
        ],
      })
      .expect(201);
    return response.body.id as string;
  }

  /** Publish everything waiting, the way the worker and the job both do. */
  async function drain(): Promise<void> {
    for (let pass = 0; pass < 20; pass += 1) {
      if ((await relay.drainOnce()) === 0) return;
    }
  }

  async function rows(reservationId?: string) {
    const { rows: found } = await pool.query<{
      kind: string;
      channel: string;
      audience: string;
      recipient: string;
      status: string;
      locale: string;
      subject: string;
      body: string;
      attempts: number;
      skipped_reason: string | null;
      last_error: string | null;
    }>(
      `SELECT kind, channel, audience, recipient, status, locale, subject, body, attempts,
              skipped_reason, last_error
         FROM notifications
        WHERE organization_id = $1 ${reservationId ? 'AND reservation_id = $2' : ''}
        ORDER BY kind, channel`,
      reservationId ? [orgId, reservationId] : [orgId],
    );
    return found;
  }

  describe('composing', () => {
    it('writes a guest confirmation when a booking is confirmed', async () => {
      const reservationId = await book();
      await drain();

      const found = await rows(reservationId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        kind: 'BOOKING_CONFIRMED',
        channel: 'EMAIL',
        audience: 'GUEST',
        recipient: 'guest@example.test',
        status: 'PENDING',
        // The property is in Thailand, so the guest is written to in Thai.
        locale: 'th',
      });
      expect(found[0]?.body).toContain('Baan Suan');
    });

    /** The relay is at-least-once; a redelivered event must not re-send. */
    it('does not write a second confirmation when an event is replayed', async () => {
      const reservationId = await book();
      await drain();
      await pool.query(`UPDATE outbox_events SET published_at = NULL WHERE organization_id = $1`, [
        orgId,
      ]);
      await drain();

      expect(await rows(reservationId)).toHaveLength(1);
    });

    it('records a skipped message when the booker left no email address', async () => {
      const reservationId = await book(null);
      await drain();

      const found = await rows(reservationId);
      expect(found[0]).toMatchObject({ status: 'SKIPPED', recipient: '' });
      expect(found[0]?.skipped_reason).toContain('No email address');
      // Still rendered and stored: the hotel can see what it did not send.
      expect(found[0]?.body.length).toBeGreaterThan(0);
    });

    it('writes a cancellation message when a booking is cancelled', async () => {
      const reservationId = await book();
      await drain();
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
        .set(auth())
        .send({ version: 0, reason: 'Guest changed plans' })
        .expect(200);
      await drain();

      const kinds = (await rows(reservationId)).map((row) => row.kind);
      expect(kinds).toContain('BOOKING_CANCELLED');
      const cancelled = (await rows(reservationId)).find((row) => row.kind === 'BOOKING_CANCELLED');
      expect(cancelled?.body).toContain('Guest changed plans');
    });

    it('says nothing about a modification, deliberately', async () => {
      const reservationId = await book();
      await drain();
      const before = (await rows(reservationId)).length;

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
        .set(auth())
        .expect(200);
      await request(app.getHttpServer())
        .patch(
          `/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${detail.body.stays[0].id as string}`,
        )
        .set(auth())
        .send({ version: 0, adults: 3 })
        .expect(200);
      await drain();

      expect(await rows(reservationId)).toHaveLength(before);
    });

    /**
     * A booking from a channel owes two messages to two different people. The
     * event is written by hand because reaching this through a real webhook
     * needs an ACTIVE channel, and an active channel needs Redis.
     */
    it('alerts staff as well as the guest when a booking arrives from a channel', async () => {
      const reservationId = await book();
      await pool.query(`UPDATE reservations SET channel_id = $1 WHERE id = $2`, [
        channelId,
        reservationId,
      ]);
      await pool.query(`DELETE FROM outbox_events WHERE organization_id = $1`, [orgId]);
      await pool.query(
        `INSERT INTO outbox_events (id, organization_id, property_id, aggregate_type,
                                    aggregate_id, event_type, payload)
         VALUES ($1, $2, $3, 'reservation', $4, 'reservation.created', $5::jsonb)`,
        [
          crypto.randomUUID(),
          orgId,
          propertyId,
          reservationId,
          JSON.stringify({
            reservationId,
            propertyId,
            code: 'X',
            status: 'CONFIRMED',
            channelId,
            affectedDates: [],
          }),
        ],
      );
      await drain();

      const found = await rows(reservationId);
      const staff = found.filter((row) => row.audience === 'STAFF');
      expect(staff).toHaveLength(1);
      expect(staff[0]).toMatchObject({
        kind: 'BOOKING_RECEIVED',
        channel: 'EMAIL',
        recipient: 'desk@baansuan.test',
      });
      // Names the channel, so the desk knows where to look for the guest.
      expect(staff[0]?.body).toContain('Agoda');
      expect(found.some((row) => row.audience === 'GUEST')).toBe(true);
    });
  });

  describe('dispatching', () => {
    it('sends what is pending and records when', async () => {
      const reservationId = await book();
      await drain();

      const result = await dispatch.runOnce();
      expect(result.sent).toBe(1);
      expect(email.sent[0]?.recipient).toBe('guest@example.test');

      const found = await rows(reservationId);
      expect(found[0]?.status).toBe('SENT');
      const { rows: timed } = await pool.query<{ sent_at: Date | null }>(
        `SELECT sent_at FROM notifications WHERE reservation_id = $1`,
        [reservationId],
      );
      expect(timed[0]?.sent_at).not.toBeNull();
    });

    it('leaves a message pending after a failure it can retry', async () => {
      const reservationId = await book();
      await drain();
      email.outcome = { status: 'FAILED', error: 'upstream 503', retryable: true };

      const result = await dispatch.runOnce();
      expect(result.deferred).toBe(1);

      const found = await rows(reservationId);
      expect(found[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(found[0]?.last_error).toContain('503');
    });

    it('gives up immediately on a failure that will never succeed', async () => {
      const reservationId = await book();
      await drain();
      email.outcome = { status: 'FAILED', error: 'invalid recipient', retryable: false };

      const result = await dispatch.runOnce();
      expect(result.failed).toBe(1);
      expect((await rows(reservationId))[0]?.status).toBe('FAILED');
    });

    it('gives up after five attempts rather than retrying forever', async () => {
      const reservationId = await book();
      await drain();
      email.outcome = { status: 'FAILED', error: 'upstream 503', retryable: true };

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await dispatch.runOnce();
      }

      const found = await rows(reservationId);
      expect(found[0]?.status).toBe('FAILED');
      expect(found[0]?.attempts).toBe(5);
      expect(email.sent).toHaveLength(5);
    });

    it('records a provider that declined to send anything', async () => {
      const reservationId = await book();
      await drain();
      email.outcome = { status: 'SKIPPED', reason: 'No email provider configured' };

      const result = await dispatch.runOnce();
      expect(result.skipped).toBe(1);

      const found = await rows(reservationId);
      expect(found[0]).toMatchObject({ status: 'SKIPPED' });
      expect(found[0]?.skipped_reason).toContain('No email provider');
    });

    it('does nothing, cheaply, when there is nothing to send', async () => {
      expect(await dispatch.runOnce()).toEqual({ sent: 0, failed: 0, skipped: 0, deferred: 0 });
    });
  });

  describe('the log endpoint', () => {
    it('returns what was sent, newest first, with counts by status', async () => {
      await book();
      await drain();
      await dispatch.runOnce();

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/notifications`)
        .set(auth())
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        kind: 'BOOKING_CONFIRMED',
        status: 'SENT',
        recipient: 'guest@example.test',
      });
      expect(response.body.summary).toMatchObject({ SENT: 1 });
    });

    it('filters by status', async () => {
      await book();
      await drain();

      const sent = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/notifications?status=SENT`)
        .set(auth())
        .expect(200);
      expect(sent.body.items).toHaveLength(0);

      const pending = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/notifications?status=PENDING`)
        .set(auth())
        .expect(200);
      expect(pending.body.items).toHaveLength(1);
    });

    it('does not leak another property’s messages', async () => {
      await book();
      await drain();

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${otherPropertyId}/notifications`)
        .set(auth())
        .expect(200);
      expect(response.body.items).toHaveLength(0);
    });

    it('rejects a malformed cursor rather than failing internally', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/notifications?cursor=not-a-cursor`)
        .set(auth())
        .expect(422);
    });
  });
});
