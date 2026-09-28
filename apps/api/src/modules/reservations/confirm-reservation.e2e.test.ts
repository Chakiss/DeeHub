/**
 * The hotel confirming a booking that waits on it, against real PostgreSQL.
 *
 * A site booking without a payment gateway is PENDING with a hold; the guest
 * is told the hotel will confirm. These prove that confirmation does exactly
 * one thing — status and the hold's expiry — and refuses everything else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Confirm e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

const NIGHTS = ['2031-08-01', '2031-08-02', '2031-08-03'] as const;

describeIfDb('Confirming a pending booking', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'confirm-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `cf-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  let token = '';
  let readerToken = '';

  beforeAll(async () => {
    const { AppModule } = await import('../../app.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { ScryptPasswordHasher } = await import('../auth/domain/password-hasher');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();

    pool = moduleRef.get<Pool>(DATABASE_POOL);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      orgId,
      orgSlug,
    ]);
    for (const [id, code] of [
      [propertyId, 'MAIN'],
      [otherPropertyId, 'ANNEX'],
    ] as const) {
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, $3, 'Confirm Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
        [id, orgId, code],
      );
    }
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 2, 4, 3, 2)`,
      [deluxeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR-DLX', 'Best Available')`,
      [deluxePlanId, orgId, propertyId, deluxeId],
    );
    await pool.query(
      `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
       VALUES ($1, $2, $3, $4, '401')`,
      [roomId, orgId, propertyId, deluxeId],
    );

    const hash = await new ScryptPasswordHasher().hash(PASSWORD);
    for (const [id, email, role] of [
      [managerId, `manager-${orgSlug}@e2e.test`, 'MANAGER'],
      [readerId, `reader-${orgSlug}@e2e.test`, 'READ_ONLY'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4, $3)`,
        [id, orgId, email, hash],
      );
      await pool.query(
        `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
         VALUES ($1, $2, $3, NULL, $4)`,
        [crypto.randomUUID(), orgId, id, role],
      );
    }

    token = await tokenFor(`manager-${orgSlug}@e2e.test`);
    readerToken = await tokenFor(`reader-${orgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'physical_rooms',
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
    await app.close();
  });

  beforeEach(async () => {
    for (const table of [
      'audit_logs',
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
         VALUES ($1, $2, $3, $4, 2)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 120000, 'THB')`,
          [orgId, propertyId, deluxePlanId, date, occupancy],
        );
      }
    }
  });

  async function tokenFor(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function book(status: 'PENDING' | 'CONFIRMED' = 'PENDING') {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'DIRECT',
        status,
        booker: { name: 'Krissada Laohongkiat', email: 'krissada@example.com' },
        stays: [
          {
            roomTypeId: deluxeId,
            ratePlanId: deluxePlanId,
            checkIn: NIGHTS[0],
            checkOut: NIGHTS[2],
            adults: 1,
          },
        ],
      })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${response.body.id as string}`)
      .set(auth())
      .expect(200);
    return { reservationId: response.body.id as string, version: detail.body.version as number };
  }

  function confirm(reservationId: string, version: number, bearer = token) {
    return request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/confirm`)
      .set({ Authorization: `Bearer ${bearer}` })
      .send({ version });
  }

  async function bookedOn(date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [deluxeId, date],
    );
    return rows[0]!.booked;
  }

  it('turns a pending hold into a confirmed booking and drops the expiry', async () => {
    const { reservationId, version } = await book();
    const before = await pool.query<{ hold_expires_at: Date | null }>(
      'SELECT hold_expires_at FROM reservations WHERE id = $1',
      [reservationId],
    );
    expect(before.rows[0]!.hold_expires_at).not.toBeNull();

    const response = await confirm(reservationId, version).expect(200);
    expect(response.body).toMatchObject({
      id: reservationId,
      status: 'CONFIRMED',
      version: version + 1,
    });

    const after = await pool.query<{ status: string; hold_expires_at: Date | null }>(
      'SELECT status, hold_expires_at FROM reservations WHERE id = $1',
      [reservationId],
    );
    expect(after.rows[0]).toMatchObject({ status: 'CONFIRMED', hold_expires_at: null });
  });

  it('moves no inventory: the hold already counted', async () => {
    const { reservationId, version } = await book();
    const held = await bookedOn(NIGHTS[0]);
    await confirm(reservationId, version).expect(200);
    expect(await bookedOn(NIGHTS[0])).toBe(held);
  });

  it('is what lets the guest be checked in afterwards', async () => {
    const { reservationId, version } = await book();
    // Not before: a hold is not a booking the desk may hand a key to.
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
      .set(auth())
      .send({ version })
      .expect(409);
    await confirm(reservationId, version).expect(200);
    // (Check-in itself needs today's date, which these far-future nights are
    // not; the status now allows it, which is the point.)
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.status).toBe('CONFIRMED');
  });

  it('refuses a booking that is not waiting: already confirmed, or cancelled', async () => {
    const confirmed = await book('CONFIRMED');
    const response = await confirm(confirmed.reservationId, confirmed.version).expect(409);
    expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const { reservationId, version } = await book();
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
      .set(auth())
      .send({ version })
      .expect(200);
    await confirm(reservationId, version + 1).expect(409);
  });

  it('refuses a stale version, another property, and a reader', async () => {
    const { reservationId, version } = await book();
    await confirm(reservationId, version + 5).expect(409);
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${otherPropertyId}/reservations/${reservationId}/confirm`)
      .set(auth())
      .send({ version })
      .expect(404);
    await confirm(reservationId, version, readerToken).expect(403);
  });

  it("audits the confirmation and queues the guest's notification", async () => {
    const { reservationId, version } = await book();
    await confirm(reservationId, version).expect(200);

    const audit = await pool.query(
      `SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'reservation.confirmed' AND entity_id = $2`,
      [orgId, reservationId],
    );
    expect(audit.rowCount).toBe(1);
    const outbox = await pool.query<{ payload: { status: string } }>(
      `SELECT payload FROM outbox_events WHERE organization_id = $1 AND aggregate_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
      [orgId, reservationId],
    );
    expect(outbox.rows[0]!.payload.status).toBe('CONFIRMED');
  });
});
