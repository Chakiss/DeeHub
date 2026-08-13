/**
 * A guest who leaves before the night they paid for, against real PostgreSQL.
 *
 * The case the first pilot property could not do in any system it had used:
 * check in at noon, check out at six, and sell the room again tonight. What
 * makes it different from `shorten-stay` is the money — the booking keeps its
 * dates and the guest keeps paying for the night. Only the room goes back.
 *
 * Every assertion here is about a real allotment row, because the whole feature
 * is "the count went back up" and a mock would prove nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Early check-out e2e tests need Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

const RATE_MINOR = 130000; // ฿1,300 — the pilot's Standard Bungalow

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describeIfDb('Checking out early and returning the room to sale', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'early-checkout-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `ec-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  let token = '';
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
       VALUES ($1, $2, 'MAIN', 'Chill Resort', 'Asia/Bangkok', 'THB', 'TH')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'BUN', 'Standard Bungalow', 2, 2, 2, 0)`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR-BUN', 'Best Available')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );
    await pool.query(
      `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
       VALUES ($1, $2, $3, $4, '3')`,
      [roomId, orgId, propertyId, roomTypeId],
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

    const { rows } = await pool.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`,
    );
    today = rows[0]!.today;

    token = await tokenFor(`manager-${orgSlug}@e2e.test`);
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
    await pool.query(`UPDATE physical_rooms SET housekeeping_status = 'CLEAN' WHERE id = $1`, [
      roomId,
    ]);

    // ONE sellable bungalow. The pilot has five, but one is what makes the
    // difference between "sold out" and "for sale" visible in a single number.
    for (const offset of [-2, -1, 0, 1, 2, 3]) {
      const date = addDays(today, offset);
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 1)`,
        [orgId, propertyId, roomTypeId, date],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy, RATE_MINOR],
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
        source: 'WALK_IN',
        booker: { name: 'Somchai Pattanakul' },
        stays: [{ roomTypeId, ratePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return {
      reservationId: response.body.id as string,
      stayId: response.body.stays[0].id as string,
      version: response.body.version as number,
    };
  }

  /** Book, assign the only room, and check in — a guest in the building. */
  async function arrive(checkIn: string, checkOut: string) {
    const { reservationId, stayId } = await book(checkIn, checkOut);

    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
      .set(auth())
      .send({ version: await currentVersion(reservationId) })
      .expect(200);

    return { reservationId, stayId };
  }

  async function currentVersion(reservationId: string): Promise<number> {
    const { rows } = await pool.query<{ version: number }>(
      'SELECT version FROM reservations WHERE id = $1',
      [reservationId],
    );
    return rows[0]!.version;
  }

  function checkOut(reservationId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
      .set(auth())
      .send(body);
  }

  async function booked(date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      `SELECT booked FROM inventory_days
        WHERE organization_id = $1 AND room_type_id = $2 AND date = $3`,
      [orgId, roomTypeId, date],
    );
    return Number(rows[0]!.booked);
  }

  async function releasedOn(stayId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT nights_released_early AS n FROM reservation_stays WHERE id = $1',
      [stayId],
    );
    return Number(rows[0]!.n);
  }

  it('returns tonight to sale when the guest leaves the day they arrived', async () => {
    const { reservationId, stayId } = await arrive(today, addDays(today, 1));
    expect(await booked(today)).toBe(1);

    const response = await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    expect(response.body.nightsReleased).toEqual([today]);
    expect(await booked(today)).toBe(0);
    expect(await releasedOn(stayId)).toBe(1);
  });

  it('keeps charging the guest for the night they left early from', async () => {
    const { reservationId } = await arrive(today, addDays(today, 1));

    await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    // The booking is untouched, so the folio still shows the night. This is the
    // whole difference from shortening a stay, and it is the hotel's money.
    const folio = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}/folio`)
      .set(auth())
      .expect(200);

    expect(folio.body.roomCharges).toHaveLength(1);
    expect(folio.body.totals.roomSubtotal).toBe(RATE_MINOR);
    expect(folio.body.totals.chargesTotal).toBeGreaterThanOrEqual(RATE_MINOR);
  });

  it('lets the freed night be sold again immediately', async () => {
    const { reservationId } = await arrive(today, addDays(today, 1));
    await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    // The only bungalow, sold twice for the same night, legitimately.
    const second = await book(today, addDays(today, 1));
    expect(second.reservationId).toBeTruthy();
    expect(await booked(today)).toBe(1);
  });

  it('hands the room to housekeeping, so it cannot be given away unclean', async () => {
    const { reservationId } = await arrive(today, addDays(today, 1));
    await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT housekeeping_status AS status FROM physical_rooms WHERE id = $1',
      [roomId],
    );
    expect(rows[0]!.status).toBe('DIRTY');
  });

  it('releases only the nights left, never one already slept', async () => {
    // Arrived yesterday on a three-night booking, leaving this evening: the
    // night of yesterday is theirs and stays sold.
    const { reservationId, stayId } = await arrive(addDays(today, -1), addDays(today, 2));
    expect(await booked(addDays(today, -1))).toBe(1);

    const response = await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    expect(response.body.nightsReleased).toEqual([today, addDays(today, 1)]);
    expect(await booked(addDays(today, -1))).toBe(1); // slept, kept
    expect(await booked(today)).toBe(0);
    expect(await booked(addDays(today, 1))).toBe(0);
    expect(await releasedOn(stayId)).toBe(2);
  });

  it('leaves inventory alone when the desk does not ask', async () => {
    const { reservationId, stayId } = await arrive(today, addDays(today, 1));

    const response = await checkOut(reservationId, {
      version: await currentVersion(reservationId),
    }).expect(200);

    // The regression guard: every caller that existed before this feature sends
    // exactly this body and must keep getting exactly this behaviour.
    expect(response.body.nightsReleased).toEqual([]);
    expect(await booked(today)).toBe(1);
    expect(await releasedOn(stayId)).toBe(0);
  });

  it('tells the channels the room is back', async () => {
    const { reservationId } = await arrive(today, addDays(today, 1));

    // Taking the booking emitted its own inventory event. Clearing here makes
    // the next assertion about THIS operation rather than about arithmetic on
    // two events that happen to describe the same night.
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);

    await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events
        WHERE organization_id = $1 AND event_type = 'inventory.changed'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.from).toBe(today);
    expect(rows[0]!.payload.to).toBe(today);
  });

  it('records what was given back, for the day somebody asks why', async () => {
    const { reservationId } = await arrive(today, addDays(today, 1));
    await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);

    const { rows } = await pool.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_logs
        WHERE organization_id = $1 AND action = 'reservation.checked_out'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after.nightsReleased).toEqual([today]);
  });

  it('refuses a stale version rather than releasing twice', async () => {
    const { reservationId, stayId } = await arrive(today, addDays(today, 1));
    const stale = (await currentVersion(reservationId)) - 1;

    await checkOut(reservationId, { version: stale, releaseRemainingNights: true }).expect(409);

    expect(await booked(today)).toBe(1);
    expect(await releasedOn(stayId)).toBe(0);
  });
});
