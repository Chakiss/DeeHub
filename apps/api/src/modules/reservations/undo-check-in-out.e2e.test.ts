/**
 * Undoing a check-in or a check-out, against real PostgreSQL.
 *
 * What matters is what comes back: the allotment count for nights an early
 * check-out had reopened, the room's occupied range, and the refusals when the
 * world has moved on (night resold, room given away, departure day passed).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Undo check-in/out e2e tests need Postgres.');
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

describeIfDb('Undoing check-in and check-out', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'undo-checkin-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `uc-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

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

  /** Which individual nights were flagged — what the reports actually read. */
  async function flaggedNights(stayId: string): Promise<string[]> {
    const { rows } = await pool.query<{ date: string }>(
      `SELECT date::text FROM reservation_stay_nights
        WHERE stay_id = $1 AND released_early ORDER BY date`,
      [stayId],
    );
    return rows.map((row) => row.date);
  }

  function undoCheckIn(reservationId: string, body: Record<string, unknown>, bearer = token) {
    return request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/undo-check-in`)
      .set({ Authorization: `Bearer ${bearer}` })
      .send(body);
  }

  function undoCheckOut(reservationId: string, body: Record<string, unknown>, bearer = token) {
    return request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/undo-check-out`)
      .set({ Authorization: `Bearer ${bearer}` })
      .send(body);
  }

  async function reservationRow(reservationId: string) {
    const { rows } = await pool.query<{
      status: string;
      checked_in_at: Date | null;
      checked_out_at: Date | null;
      version: number;
    }>('SELECT status, checked_in_at, checked_out_at, version FROM reservations WHERE id = $1', [
      reservationId,
    ]);
    return rows[0]!;
  }

  async function stayRow(stayId: string) {
    const { rows } = await pool.query<{
      room_released_on: string | null;
      nights_released_early: number;
      assigned_room_id: string | null;
    }>(
      `SELECT room_released_on::text, nights_released_early, assigned_room_id
         FROM reservation_stays WHERE id = $1`,
      [stayId],
    );
    return rows[0]!;
  }

  async function releasedAtSet(stayId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reservation_stay_nights
        WHERE stay_id = $1 AND (released_early OR released_at IS NOT NULL)`,
      [stayId],
    );
    return Number(rows[0]!.n);
  }

  async function checkOutEarly(reservationId: string) {
    await checkOut(reservationId, {
      version: await currentVersion(reservationId),
      releaseRemainingNights: true,
    }).expect(200);
  }

  describe('undo check-in', () => {
    it('returns the booking to CONFIRMED, keeps the room, and can be checked in again', async () => {
      const { reservationId, stayId } = await arrive(today, addDays(today, 1));
      const before = await currentVersion(reservationId);

      const response = await undoCheckIn(reservationId, {
        version: before,
        note: 'wrong row',
      }).expect(200);
      expect(response.body).toEqual({
        id: reservationId,
        status: 'CONFIRMED',
        version: before + 1,
      });

      const row = await reservationRow(reservationId);
      expect(row.status).toBe('CONFIRMED');
      expect(row.checked_in_at).toBeNull();
      expect((await stayRow(stayId)).assigned_room_id).toBe(roomId);
      expect(await booked(today)).toBe(1);

      const audit = await pool.query(
        `SELECT before, after FROM audit_logs WHERE entity_id = $1 AND action = 'reservation.check_in_undone'`,
        [reservationId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].after.note).toBe('wrong row');
      expect(audit.rows[0].before.checkedInAt).toBeTruthy();

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: await currentVersion(reservationId) })
        .expect(200);
    });

    it('refuses a booking that was never checked in, and a stale version', async () => {
      const { reservationId } = await book(addDays(today, 1), addDays(today, 2));
      const never = await undoCheckIn(reservationId, {
        version: await currentVersion(reservationId),
      }).expect(409);
      expect(never.body.error.code).toBe('INVALID_STATE_TRANSITION');

      const arrived = await arrive(today, addDays(today, 1));
      const stale = await undoCheckIn(arrived.reservationId, { version: 0 }).expect(409);
      expect(stale.body.error.code).toBe('VERSION_MISMATCH');
      expect((await reservationRow(arrived.reservationId)).status).toBe('CHECKED_IN');
    });
  });

  describe('undo check-out', () => {
    it('after a normal departure-day check-out: back in house, inventory unchanged', async () => {
      const { reservationId } = await arrive(addDays(today, -1), today);
      await checkOut(reservationId, { version: await currentVersion(reservationId) }).expect(200);
      expect(await booked(addDays(today, -1))).toBe(1);

      const response = await undoCheckOut(reservationId, {
        version: await currentVersion(reservationId),
      }).expect(200);
      expect(response.body).toMatchObject({
        status: 'CHECKED_IN',
        nightsRestored: [],
        roomsStillDirty: ['3'],
      });

      const row = await reservationRow(reservationId);
      expect(row.status).toBe('CHECKED_IN');
      expect(row.checked_out_at).toBeNull();
      expect(await booked(addDays(today, -1))).toBe(1);
      expect(await booked(today)).toBe(0);
    });

    it('after an early check-out with release: takes the nights back and re-occupies the room', async () => {
      const { reservationId, stayId } = await arrive(today, addDays(today, 2));
      await checkOutEarly(reservationId);
      expect(await booked(today)).toBe(0);
      expect(await booked(addDays(today, 1))).toBe(0);
      await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);

      const response = await undoCheckOut(reservationId, {
        version: await currentVersion(reservationId),
      }).expect(200);
      expect(response.body.nightsRestored).toEqual([today, addDays(today, 1)]);
      expect(response.body.roomsStillDirty).toEqual(['3']);

      expect(await booked(today)).toBe(1);
      expect(await booked(addDays(today, 1))).toBe(1);
      expect(await releasedAtSet(stayId)).toBe(0);
      const stay = await stayRow(stayId);
      expect(stay.nights_released_early).toBe(0);
      expect(stay.room_released_on).toBeNull();
      expect((await reservationRow(reservationId)).status).toBe('CHECKED_IN');

      const outbox = await pool.query(
        `SELECT event_type FROM outbox_events WHERE organization_id = $1 AND event_type = 'inventory.changed'`,
        [orgId],
      );
      expect(outbox.rows.length).toBeGreaterThanOrEqual(1);

      // Housekeeping untouched: the room is still dirty.
      const hk = await pool.query(
        'SELECT housekeeping_status AS s FROM physical_rooms WHERE id = $1',
        [roomId],
      );
      expect(hk.rows[0].s).toBe('DIRTY');
    });

    it('refuses with INVENTORY_UNAVAILABLE when the freed night was resold, changing nothing', async () => {
      const { reservationId, stayId } = await arrive(today, addDays(today, 1));
      await checkOutEarly(reservationId);
      await book(today, addDays(today, 1)); // the only bungalow, sold again
      const version = await currentVersion(reservationId);

      const response = await undoCheckOut(reservationId, { version }).expect(409);
      expect(response.body.error.code).toBe('INVENTORY_UNAVAILABLE');

      const row = await reservationRow(reservationId);
      expect(row.status).toBe('CHECKED_OUT');
      expect(row.version).toBe(version);
      expect(await booked(today)).toBe(1);
      expect(await releasedAtSet(stayId)).toBe(1);
      expect((await stayRow(stayId)).nights_released_early).toBe(1);
    });

    it('refuses with a conflict naming the room when it was assigned to another guest', async () => {
      const { reservationId, stayId } = await arrive(today, addDays(today, 2));
      await checkOutEarly(reservationId);
      // Room for two guests' worth of allotment so the inventory is not what refuses.
      await pool.query(`UPDATE inventory_days SET allotment = 2 WHERE organization_id = $1`, [
        orgId,
      ]);
      const next = await book(today, addDays(today, 1));
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${next.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);
      const version = await currentVersion(reservationId);

      const response = await undoCheckOut(reservationId, { version }).expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toContain('Room 3');

      const row = await reservationRow(reservationId);
      expect(row.status).toBe('CHECKED_OUT');
      expect(row.version).toBe(version);
      expect(await booked(today)).toBe(1); // only the other guest
      expect(await releasedAtSet(stayId)).toBe(2);
      expect((await stayRow(stayId)).room_released_on).toBe(today);
    });

    it('refuses once the booked departure day has passed', async () => {
      const { reservationId } = await arrive(addDays(today, -2), addDays(today, -1));
      await checkOut(reservationId, { version: await currentVersion(reservationId) }).expect(200);

      const response = await undoCheckOut(reservationId, {
        version: await currentVersion(reservationId),
      }).expect(422);
      expect(response.body.error.code).toBe('CHECK_OUT_UNDO_TOO_LATE');
      expect((await reservationRow(reservationId)).status).toBe('CHECKED_OUT');
    });

    it('refuses the whole undo when the second stay released night was resold', async () => {
      // Two stays in one booking, back to back, both in the only room.
      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth())
        .send({
          source: 'WALK_IN',
          booker: { name: 'Two Stay Guest' },
          stays: [
            { roomTypeId, ratePlanId, checkIn: today, checkOut: addDays(today, 1), adults: 2 },
            {
              roomTypeId,
              ratePlanId,
              checkIn: addDays(today, 1),
              checkOut: addDays(today, 2),
              adults: 2,
            },
          ],
        })
        .expect(201);
      const reservationId = created.body.id as string;
      for (const stay of created.body.stays as { id: string }[]) {
        await request(app.getHttpServer())
          .patch(`/api/v1/properties/${propertyId}/stays/${stay.id}/room`)
          .set(auth())
          .send({ roomId })
          .expect(200);
      }
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: await currentVersion(reservationId) })
        .expect(200);
      await checkOutEarly(reservationId);
      expect(await booked(today)).toBe(0);
      expect(await booked(addDays(today, 1))).toBe(0);

      await book(addDays(today, 1), addDays(today, 2)); // the second stay's night, resold
      const version = await currentVersion(reservationId);

      const response = await undoCheckOut(reservationId, { version }).expect(409);
      expect(response.body.error.code).toBe('INVENTORY_UNAVAILABLE');

      // The first stay's night was not taken back: the whole undo rolled back.
      expect(await booked(today)).toBe(0);
      expect(await booked(addDays(today, 1))).toBe(1);
      expect((await reservationRow(reservationId)).status).toBe('CHECKED_OUT');
    });

    it('restores past released nights when undone on a later business day', async () => {
      const { reservationId, stayId } = await arrive(addDays(today, -1), addDays(today, 1));
      await checkOutEarly(reservationId); // releases tonight
      // Simulate the check-out having been done yesterday: yesterday's night
      // was released too, as it would have been then.
      await pool.query(
        `UPDATE reservation_stay_nights SET released_early = true, released_at = now()
          WHERE stay_id = $1 AND date = $2`,
        [stayId, addDays(today, -1)],
      );
      await pool.query(
        `UPDATE inventory_days SET booked = booked - 1
          WHERE organization_id = $1 AND room_type_id = $2 AND date = $3`,
        [orgId, roomTypeId, addDays(today, -1)],
      );
      await pool.query(`UPDATE reservation_stays SET nights_released_early = 2 WHERE id = $1`, [
        stayId,
      ]);

      const response = await undoCheckOut(reservationId, {
        version: await currentVersion(reservationId),
      }).expect(200);
      expect(response.body.nightsRestored).toEqual([addDays(today, -1), today]);
      expect(await booked(addDays(today, -1))).toBe(1);
      expect(await booked(today)).toBe(1);
      expect(await releasedAtSet(stayId)).toBe(0);
    });

    it('refuses a booking that is not checked out, and a stale version', async () => {
      const { reservationId } = await arrive(today, addDays(today, 1));
      const notOut = await undoCheckOut(reservationId, {
        version: await currentVersion(reservationId),
      }).expect(409);
      expect(notOut.body.error.code).toBe('INVALID_STATE_TRANSITION');

      await checkOut(reservationId, { version: await currentVersion(reservationId) }).expect(200);
      const stale = await undoCheckOut(reservationId, { version: 0 }).expect(409);
      expect(stale.body.error.code).toBe('VERSION_MISMATCH');
    });
  });

  describe('the forward endpoints do not become back doors', () => {
    it('refuses to check in a checked-out booking', async () => {
      const { reservationId } = await arrive(today, addDays(today, 1));
      await checkOut(reservationId, { version: await currentVersion(reservationId) }).expect(200);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: await currentVersion(reservationId) })
        .expect(409);
      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('refuses to confirm a checked-in booking', async () => {
      const { reservationId } = await arrive(today, addDays(today, 1));
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/confirm`)
        .set(auth())
        .send({ version: await currentVersion(reservationId) })
        .expect(409);
      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('permissions', () => {
    it('forbids a READ_ONLY user from both endpoints', async () => {
      const { reservationId } = await arrive(today, addDays(today, 1));
      const reader = await tokenFor(`reader-${orgSlug}@e2e.test`);
      const version = await currentVersion(reservationId);

      const inResponse = await undoCheckIn(reservationId, { version }, reader).expect(403);
      expect(inResponse.body.error.details.capability).toBe('reservation:checkin');
      const outResponse = await undoCheckOut(reservationId, { version }, reader).expect(403);
      expect(outResponse.body.error.details.capability).toBe('reservation:checkout');
    });
  });
});
