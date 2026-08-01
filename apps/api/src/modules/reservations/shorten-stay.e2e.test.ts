/**
 * A guest leaving early, against real PostgreSQL.
 *
 * The mirror of the extend suite. The point of these is that only the TAIL is
 * released: nights the guest has already slept keep their inventory and their
 * frozen price, because giving one back would retroactively claim the hotel had
 * a room free on a night it did not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Shorten e2e tests must run against Postgres.');
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

describeIfDb('Shortening a stay', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'shorten-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `sh-${orgId.slice(0, 8)}`;
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
       VALUES ($1, $2, 'MAIN', 'Shorten Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
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
    // Negative offsets too: one case backdates a stay so it has nights the
    // guest has already slept through, which cannot be created through the API.
    const dates = [...NIGHTS, ...[-2, -1, 0, 1, 2, 3, 4].map((offset) => addDays(today, offset))];
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

  function shorten(reservationId: string, stayId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(
        `/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/shorten`,
      )
      .set(auth())
      .send(body);
  }

  /**
   * Move a checked-in stay's arrival into the past.
   *
   * The booking path refuses an arrival in the past — correctly — but "the
   * guest checked in two days ago" is the state early departure exists for, so
   * the tests that need it fabricate exactly that one column and the night rows
   * that go with it. Everything else came through the real API.
   */
  async function backdateArrival(
    reservationId: string,
    stayId: string,
    nightsBefore: number,
  ): Promise<void> {
    await pool.query('UPDATE reservation_stays SET check_in = $1 WHERE id = $2', [
      addDays(today, -nightsBefore),
      stayId,
    ]);

    for (let offset = -nightsBefore; offset < 0; offset += 1) {
      await pool.query(
        `INSERT INTO reservation_stay_nights
           (stay_id, date, organization_id, reservation_id, property_id, room_type_id,
            amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'THB')`,
        [stayId, addDays(today, offset), orgId, reservationId, propertyId, deluxeId, RATE_MINOR],
      );
      await pool.query(
        `UPDATE inventory_days SET booked = booked + 1 WHERE room_type_id = $1 AND date = $2`,
        [deluxeId, addDays(today, offset)],
      );
    }
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

  it('releases the dropped nights and keeps the rest', async () => {
    // Booked five nights, leaving after three.
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 5));
    expect(await bookedOn(NIGHTS[3])).toBe(1);

    const response = await shorten(reservationId, stayId, {
      version: 0,
      checkOut: NIGHTS[3],
    }).expect(200);

    expect(response.body.releasedNights).toEqual([NIGHTS[3], NIGHTS[4]]);

    // The nights they are still staying keep their hold.
    for (const night of [NIGHTS[0], NIGHTS[1], NIGHTS[2]]) {
      expect(await bookedOn(night), night).toBe(1);
    }
    // The nights they are not are back in the pool.
    for (const night of [NIGHTS[3], NIGHTS[4]]) {
      expect(await bookedOn(night), night).toBe(0);
    }
  });

  it('takes the dropped nights off the bill at the price they were quoted', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 5));
    const before = await detail(reservationId);

    const response = await shorten(reservationId, stayId, {
      version: 0,
      checkOut: NIGHTS[3],
    }).expect(200);

    expect(response.body.refundedAmount.amount).toBe(RATE_MINOR * 2);
    expect(response.body.total.amount).toBeLessThan(before.total.amount);

    // Recomputed from the surviving nights, not by subtracting a delta: tax and
    // service charge are percentages of the whole.
    const after = await detail(reservationId);
    expect(after.subtotal.amount).toBe(RATE_MINOR * 3);
    expect(after.stays[0].nights).toHaveLength(3);
  });

  it('leaves a rate that moved since booking out of it', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 5));

    // The hotel raises its price after the guest booked.
    await pool.query(
      `UPDATE rate_days SET amount_minor = $1
        WHERE rate_plan_id = $2 AND date >= $3`,
      [RATE_MINOR * 4, deluxePlanId, NIGHTS[3]],
    );

    const response = await shorten(reservationId, stayId, {
      version: 0,
      checkOut: NIGHTS[3],
    }).expect(200);

    // Credited what they were charged, not what the night is worth today.
    expect(response.body.refundedAmount.amount).toBe(RATE_MINOR * 2);
  });

  it('shortens a stay the guest is currently in the middle of', async () => {
    // The case a modification refuses outright, and the reason this exists.
    const { reservationId, stayId } = await book(today, addDays(today, 4));
    const version = await checkIn(reservationId, stayId, roomAId);

    const response = await shorten(reservationId, stayId, {
      version,
      checkOut: addDays(today, 1),
    }).expect(200);

    expect(response.body.releasedNights).toEqual([
      addDays(today, 1),
      addDays(today, 2),
      addDays(today, 3),
    ]);
    // Tonight is theirs and stays held.
    expect(await bookedOn(today)).toBe(1);
    expect(await bookedOn(addDays(today, 1))).toBe(0);
  });

  it('lets a guest who arrived yesterday leave this morning', async () => {
    // The classic early departure, and the one a modification cannot do.
    const { reservationId, stayId } = await book(today, addDays(today, 3));
    const version = await checkIn(reservationId, stayId, roomAId);
    await backdateArrival(reservationId, stayId, 1);

    const response = await shorten(reservationId, stayId, {
      version,
      checkOut: today,
    }).expect(200);

    /*
     * Tonight is released and last night is not. The night "of the 3rd" is the
     * night BETWEEN the 3rd and the 4th, so a guest leaving on the morning of
     * the 3rd never consumed it — while the night of the 2nd they slept
     * through, and giving that back would claim the room was free.
     */
    expect(response.body.releasedNights).toContain(today);
    expect(response.body.releasedNights).not.toContain(addDays(today, -1));
    expect(await bookedOn(today)).toBe(0);
    expect(await bookedOn(addDays(today, -1))).toBe(1);
  });

  it('refuses to release a night the guest has already slept through', async () => {
    const { reservationId, stayId } = await book(today, addDays(today, 2));
    const version = await checkIn(reservationId, stayId, roomAId);

    await backdateArrival(reservationId, stayId, 2);

    const response = await shorten(reservationId, stayId, {
      version,
      checkOut: addDays(today, -1),
    }).expect(422);

    // Releasing it would claim the hotel had a room free on a night it did not.
    expect(response.body.error.message).toMatch(/already slept/i);
    // And nothing was released: the transaction rolled back whole.
    const { rows } = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [deluxeId, addDays(today, -1)],
    );
    expect(rows[0]?.booked).toBe(1);
  });

  it('keeps the assigned room', async () => {
    const { reservationId, stayId } = await book(today, addDays(today, 4));
    const version = await checkIn(reservationId, stayId, roomAId);

    await shorten(reservationId, stayId, { version, checkOut: addDays(today, 2) }).expect(200);

    // Unlike a modification, which clears it: the guest is physically in that
    // room until they walk out of it.
    const body = await detail(reservationId);
    expect(body.stays[0].assignedRoomId).toBe(roomAId);
  });

  it('frees the room for somebody else on the released nights', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 5));
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId: roomAId })
      .expect(200);

    await shorten(reservationId, stayId, { version: 0, checkOut: NIGHTS[3] }).expect(200);

    // The whole operational point: the room can be sold again.
    const next = await book(NIGHTS[3], addDays(NIGHTS[0], 5));
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${next.stayId}/room`)
      .set(auth())
      .send({ roomId: roomAId })
      .expect(200);
  });

  it('refuses a check-out that is not earlier than the current one', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 3));

    for (const checkOut of [addDays(NIGHTS[0], 3), addDays(NIGHTS[0], 4)]) {
      // Later is an extension, and this must not silently become one.
      await shorten(reservationId, stayId, { version: 0, checkOut }).expect(422);
    }
  });

  it('refuses to shorten a stay to nothing', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 3));

    const response = await shorten(reservationId, stayId, {
      version: 0,
      checkOut: NIGHTS[0],
    }).expect(422);

    // A zero-night booking would hold no inventory, appear on no night, and
    // never be closed by anybody. That is a cancellation.
    expect(response.body.error.message).toMatch(/cancel the booking/i);
  });

  it('refuses on a stale version', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 4));

    await shorten(reservationId, stayId, { version: 0, checkOut: NIGHTS[3] }).expect(200);
    // A second tab acting on what it read before the first one wrote.
    await shorten(reservationId, stayId, { version: 0, checkOut: NIGHTS[2] }).expect(409);
  });

  it('refuses a cancelled booking', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 4));
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    await shorten(reservationId, stayId, { version: 1, checkOut: NIGHTS[2] }).expect(409);
  });

  it('refuses a stay that belongs to a different booking', async () => {
    const first = await book(NIGHTS[0], addDays(NIGHTS[0], 3));
    const second = await book(NIGHTS[0], addDays(NIGHTS[0], 3));

    await shorten(first.reservationId, second.stayId, {
      version: 0,
      checkOut: NIGHTS[1],
    }).expect(404);
  });

  it('refuses a read-only user', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 3));

    await request(app.getHttpServer())
      .post(
        `/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/shorten`,
      )
      .set({ Authorization: `Bearer ${readerToken}` })
      .send({ version: 0, checkOut: NIGHTS[1] })
      .expect(403);
  });

  it('records what was released, and that no fee was charged', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 4));

    await shorten(reservationId, stayId, {
      version: 0,
      checkOut: NIGHTS[2],
      reason: 'Guest called away',
    }).expect(200);

    const { rows } = await pool.query<{ after: Record<string, unknown>; reason: string }>(
      `SELECT after, reason FROM audit_logs
        WHERE organization_id = $1 AND action = 'reservation.shortened'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Guest called away');
    expect(rows[0]?.after['releasedNights']).toEqual([NIGHTS[2], NIGHTS[3]]);
    // Recorded explicitly, so that when a folio exists the merge between the
    // two is not a guess about what this operation used to do.
    expect(rows[0]?.after['earlyDepartureFeeMinor']).toBe(0);
  });

  it('tells the channel only about the nights that changed', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 4));

    await shorten(reservationId, stayId, { version: 0, checkOut: NIGHTS[2] }).expect(200);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events
        WHERE organization_id = $1 AND event_type = 'inventory.changed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgId],
    );
    // Re-pushing untouched nights is noise a channel has to reconcile against
    // numbers that did not move.
    expect(rows[0]?.payload['from']).toBe(NIGHTS[2]);
    expect(rows[0]?.payload['to']).toBe(NIGHTS[3]);
  });
});
