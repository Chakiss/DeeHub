/**
 * Keeping a guest longer, against real PostgreSQL.
 *
 * The point of these is the difference from a modification: nothing is ever
 * released. The nights the stay already holds keep their inventory and the
 * price the guest was quoted, including — and especially — nights already slept
 * in, which is the case a modification refuses outright.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Extend e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/** Far future, so these stays never become "begun" while the suite runs. */
const NIGHTS = ['2031-05-01', '2031-05-02', '2031-05-03', '2031-05-04', '2031-05-05'] as const;
const RATE_MINOR = 120000;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describeIfDb('Extending a stay', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'extend-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `ex-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const roomAId = crypto.randomUUID();
  const roomBId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  let token = '';
  let readerToken = '';
  /** Today in the property's timezone — the in-house cases need real dates. */
  let today = '';

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
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
       VALUES ($1, $2, 'MAIN', 'Extend Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
      [propertyId, orgId],
    );
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
    for (const [roomId, number] of [
      [roomAId, '301'],
      [roomBId, '302'],
    ] as const) {
      await pool.query(
        `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [roomId, orgId, propertyId, deluxeId, number],
      );
    }

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

    const { rows } = await pool.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`,
    );
    today = rows[0]!.today;

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

    // Two sellable units at one price, over the far-future window AND a window
    // around today for the in-house cases.
    const dates = [...NIGHTS, ...[0, 1, 2, 3, 4].map((offset) => addDays(today, offset))];
    for (const date of dates) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 2)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
          [orgId, propertyId, deluxePlanId, date, occupancy, RATE_MINOR],
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

  async function book(checkIn: string, checkOut: string) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'PHONE',
        booker: { name: 'Naruemon Chaiyaporn' },
        stays: [{ roomTypeId: deluxeId, ratePlanId: deluxePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return {
      reservationId: response.body.id as string,
      stayId: response.body.stays[0].id as string,
    };
  }

  function extend(reservationId: string, stayId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/extend`)
      .set(auth())
      .send(body);
  }

  async function bookedOn(date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [deluxeId, date],
    );
    return rows[0]?.booked ?? -1;
  }

  async function detail(reservationId: string) {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);
    return response.body;
  }

  /**
   * Assign a room and check the booking in, the way a front desk would.
   *
   * Returns the version as the API now reports it — check-in bumps it, and
   * hard-coding the new number here would make these tests pass for the wrong
   * reason if that ever changed.
   */
  async function checkIn(reservationId: string, stayId: string, roomId: string) {
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    const body = await detail(reservationId);
    return body.version as number;
  }

  it('adds the nights to the end and holds inventory for them', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');

    const response = await extend(reservationId, stayId, {
      version: 0,
      checkOut: '2031-05-05',
    }).expect(200);

    expect(response.body.addedNights).toEqual(['2031-05-03', '2031-05-04']);
    expect(response.body.checkOut).toBe('2031-05-05');
    expect(await bookedOn('2031-05-03')).toBe(1);
    expect(await bookedOn('2031-05-04')).toBe(1);
  });

  it('never releases a night the stay already held', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');
    await extend(reservationId, stayId, { version: 0, checkOut: '2031-05-04' }).expect(200);

    expect(await bookedOn('2031-05-01')).toBe(1);
    expect(await bookedOn('2031-05-02')).toBe(1);
  });

  /**
   * The guest keeps the price they were quoted. Only the added nights are
   * quoted at whatever the rate plan says today.
   */
  it('leaves the existing nights at the price they were sold', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');

    await pool.query(
      `UPDATE rate_days SET amount_minor = $1 WHERE rate_plan_id = $2 AND organization_id = $3`,
      [RATE_MINOR * 3, deluxePlanId, orgId],
    );

    const response = await extend(reservationId, stayId, {
      version: 0,
      checkOut: '2031-05-04',
    }).expect(200);

    const body = await detail(reservationId);
    const nights: { date: string; amount: number }[] = body.stays[0].nights;
    expect(nights.find((night) => night.date === '2031-05-01')?.amount).toBe(RATE_MINOR);
    expect(nights.find((night) => night.date === '2031-05-02')?.amount).toBe(RATE_MINOR);
    expect(nights.find((night) => night.date === '2031-05-03')?.amount).toBe(RATE_MINOR * 3);
    expect(response.body.addedAmount.amount).toBe(RATE_MINOR * 3);
    expect(body.subtotal.amount).toBe(RATE_MINOR * 2 + RATE_MINOR * 3);
  });

  it('bumps the version so a second extension must re-read', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-02');

    const first = await extend(reservationId, stayId, {
      version: 0,
      checkOut: '2031-05-03',
    }).expect(200);
    expect(first.body.version).toBe(1);

    await extend(reservationId, stayId, { version: 0, checkOut: '2031-05-04' }).expect(409);
  });

  it('refuses a check-out that is not later than the current one', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');

    await extend(reservationId, stayId, { version: 0, checkOut: '2031-05-02' }).expect(422);
    await extend(reservationId, stayId, { version: 0, checkOut: '2031-05-03' }).expect(422);
  });

  it('refuses when an added night is sold out, leaving the booking untouched', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');
    await pool.query(
      `UPDATE inventory_days SET allotment = booked WHERE room_type_id = $1 AND date = $2`,
      [deluxeId, '2031-05-03'],
    );

    await extend(reservationId, stayId, { version: 0, checkOut: '2031-05-04' }).expect(409);

    const body = await detail(reservationId);
    expect(body.stays[0].checkOut).toBe('2031-05-03');
    expect(body.stays[0].nights).toHaveLength(2);
    expect(body.version).toBe(0);
  });

  it('refuses when the rate plan has no price for an added night', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');
    await pool.query(`DELETE FROM rate_days WHERE rate_plan_id = $1 AND date = $2`, [
      deluxePlanId,
      '2031-05-03',
    ]);

    const response = await extend(reservationId, stayId, {
      version: 0,
      checkOut: '2031-05-04',
    }).expect(422);
    expect(response.body.error.code).toBe('RATE_MISSING');

    // The rollback must give the night back; a refused extension that kept the
    // hold would quietly remove a sellable room from the market.
    expect(await bookedOn('2031-05-03')).toBe(0);
  });

  it('refuses a booking that is not extendable', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    const response = await extend(reservationId, stayId, {
      version: 1,
      checkOut: '2031-05-04',
    }).expect(409);
    expect(response.body.error.message).toContain('CANCELLED');
  });

  it('records the extension in the audit trail', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');
    await extend(reservationId, stayId, {
      version: 0,
      checkOut: '2031-05-04',
      reason: 'Guest asked at the desk',
    }).expect(200);

    const { rows } = await pool.query<{
      before: { checkOut: string };
      after: { checkOut: string; addedNights: string[] };
      reason: string | null;
    }>(
      `SELECT before, after, reason FROM audit_logs
       WHERE entity_id = $1 AND action = 'reservation.extended'`,
      [reservationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before.checkOut).toBe('2031-05-03');
    expect(rows[0]!.after.checkOut).toBe('2031-05-04');
    expect(rows[0]!.after.addedNights).toEqual(['2031-05-03']);
    expect(rows[0]!.reason).toBe('Guest asked at the desk');
  });

  it('is refused without reservation:modify', async () => {
    const { reservationId, stayId } = await book('2031-05-01', '2031-05-03');

    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/extend`)
      .set({ Authorization: `Bearer ${readerToken}` })
      .send({ version: 0, checkOut: '2031-05-04' })
      .expect(403);
  });

  it('refuses a stay that belongs to another booking', async () => {
    const first = await book('2031-05-01', '2031-05-02');
    const second = await book('2031-05-03', '2031-05-04');

    await extend(first.reservationId, second.stayId, {
      version: 0,
      checkOut: '2031-05-05',
    }).expect(404);
  });

  /* The reason this use case exists: modification refuses all of these. */
  describe('a guest who is already in the building', () => {
    it('extends a checked-in stay and keeps them in their room', async () => {
      const { reservationId, stayId } = await book(today, addDays(today, 1));
      const version = await checkIn(reservationId, stayId, roomAId);

      const response = await extend(reservationId, stayId, {
        version,
        checkOut: addDays(today, 3),
      }).expect(200);

      expect(response.body.addedNights).toEqual([addDays(today, 1), addDays(today, 2)]);

      const body = await detail(reservationId);
      expect(body.status).toBe('CHECKED_IN');
      expect(body.stays[0].assignedRoomNumber).toBe('301');
      // The consumed night is still held: the guest slept in it.
      expect(await bookedOn(today)).toBe(1);
    });

    it('refuses when the assigned room is taken on one of the added nights', async () => {
      const inHouse = await book(today, addDays(today, 1));
      const version = await checkIn(inHouse.reservationId, inHouse.stayId, roomAId);

      // Someone else already has 301 from tomorrow.
      const next = await book(addDays(today, 1), addDays(today, 3));
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${next.stayId}/room`)
        .set(auth())
        .send({ roomId: roomAId })
        .expect(200);

      const response = await extend(inHouse.reservationId, inHouse.stayId, {
        version,
        checkOut: addDays(today, 2),
      }).expect(409);

      expect(response.body.error.message).toContain('301');
      expect(response.body.error.details.conflictingReservation).toBeDefined();

      // Refused, not half-applied: the night must go back on the market.
      expect(await bookedOn(addDays(today, 1))).toBe(1);
    });

    it('extends an unassigned in-house stay without complaint', async () => {
      const { reservationId, stayId } = await book(today, addDays(today, 1));
      const version = await checkIn(reservationId, stayId, roomBId);
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId: null })
        .expect(200);

      await extend(reservationId, stayId, { version, checkOut: addDays(today, 2) }).expect(200);

      expect(await bookedOn(addDays(today, 1))).toBe(1);
    });
  });
});
