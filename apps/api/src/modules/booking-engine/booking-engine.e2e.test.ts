/**
 * The direct booking engine, against real PostgreSQL.
 *
 * These are the only routes in the system a stranger can reach, so the point of
 * most of them is what a stranger CANNOT do: name a price, reach another
 * tenant, book a room that is not for sale, or pay for somebody else's booking.
 *
 * No payment provider is configured in tests, which is itself the case worth
 * covering — a hotel without one still takes bookings, held for a human.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. Booking engine e2e tests must run against Postgres.',
  );
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/**
 * A month out, not 2031 like the other suites.
 *
 * The booking engine refuses a date beyond the inventory horizon — a public
 * endpoint that accepts 2099 is a public endpoint that scans for nothing — so a
 * far-future window would be rejected before any of this was exercised.
 */
const NIGHTS = [0, 1, 2, 3, 4].map((offset) =>
  new Date(Date.now() + (30 + offset) * 86_400_000).toISOString().slice(0, 10),
) as unknown as readonly [string, string, string, string, string];
const RATE_MINOR = 120000;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describeIfDb('Booking engine', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'booking-engine-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `be-${orgId.slice(0, 8)}`;
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
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                               tax_rate_bp, service_charge_rate_bp)
       VALUES ($1, $2, 'MAIN', 'Booking Engine Hotel', 'Asia/Bangkok', 'THB', 'TH', 700, 1000)`,
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
      'folio_payments',
      'folio_charges',
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
      'folio_payments',
      'folio_charges',
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

  /** No Authorization header anywhere below: that is the point of these. */
  const publicUrl = (suffix = '') => `/api/v1/public/${orgSlug}/MAIN${suffix}`;

  function searchPublic(checkIn: string, checkOut: string, extra = '') {
    return request(app.getHttpServer()).get(
      `${publicUrl('/availability')}?checkIn=${checkIn}&checkOut=${checkOut}${extra}`,
    );
  }

  function bookPublic(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post(publicUrl('/bookings')).send(body);
  }

  function validBooking(
    checkIn: string,
    checkOut: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      guest: { name: 'Ploy Sukhum', email: 'ploy@example.test' },
      checkIn,
      checkOut,
      stays: [{ roomTypeId: deluxeId, ratePlanId: deluxePlanId, adults: 2 }],
      ...overrides,
    };
  }

  async function bookedOn(date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [deluxeId, date],
    );
    return rows[0]?.booked ?? -1;
  }

  it('shows a stranger the hotel without showing them the tenant', async () => {
    const response = await request(app.getHttpServer()).get(publicUrl()).expect(200);

    expect(response.body).toMatchObject({ name: 'Booking Engine Hotel', currency: 'THB' });
    // Explicitly small: a column added to `properties` later must not become
    // public by default.
    expect(response.body).not.toHaveProperty('id');
    expect(response.body).not.toHaveProperty('organizationId');
    // No provider is configured in tests, and the page needs to know.
    expect(response.body.paymentAvailable).toBe(false);
  });

  it('answers the same way for a wrong slug, a wrong code and a real one', async () => {
    const wrongSlug = await request(app.getHttpServer())
      .get(`/api/v1/public/not-a-hotel/MAIN`)
      .expect(404);
    const wrongCode = await request(app.getHttpServer())
      .get(`/api/v1/public/${orgSlug}/NOPE`)
      .expect(404);

    // Neither distinction is a stranger's business.
    expect(wrongSlug.body.error.code).toBe(wrongCode.body.error.code);
  });

  it('prices a stay from the hotel own rate plan', async () => {
    const response = await searchPublic(NIGHTS[0], addDays(NIGHTS[0], 2)).expect(200);

    const roomType = response.body.roomTypes[0];
    expect(roomType.name).toBe('Deluxe');
    expect(roomType.ratePlans[0].total).toBe(RATE_MINOR * 2);
    expect(roomType.ratePlans[0].perNight).toHaveLength(2);
  });

  it('shows a guest only what they can book', async () => {
    // A three-night minimum on the first night. Staff see the reason; a guest
    // seeing a list of rooms they may not have reads as a broken page.
    await pool.query(
      `UPDATE inventory_days SET min_stay = 3 WHERE room_type_id = $1 AND date = $2`,
      [deluxeId, NIGHTS[0]],
    );

    const response = await searchPublic(NIGHTS[0], addDays(NIGHTS[0], 1)).expect(200);
    expect(response.body.roomTypes).toHaveLength(0);
    // And no explanation of the hotel's commercial rules.
    expect(JSON.stringify(response.body)).not.toContain('RESTRICTION');
  });

  it('refuses a stay longer than anyone books online', async () => {
    await searchPublic(NIGHTS[0], addDays(NIGHTS[0], 31)).expect(422);
  });

  it('refuses a date too far ahead to be real', async () => {
    await searchPublic('2099-01-01', '2099-01-02').expect(422);
  });

  it('refuses an inverted stay', async () => {
    await searchPublic(addDays(NIGHTS[0], 2), NIGHTS[0]).expect(422);
  });

  it('takes a booking as a hold, not as a confirmed sale', async () => {
    const response = await bookPublic(validBooking(NIGHTS[0], addDays(NIGHTS[0], 2))).expect(201);

    // A CONFIRMED booking nobody has paid for is a room given away.
    expect(response.body.status).toBe('PENDING');
    expect(response.body.code).toBeTruthy();
    expect(response.body.holdExpiresInSeconds).toBeGreaterThan(0);
    // The code, never the id: it is the only handle the payment step accepts.
    expect(response.body).not.toHaveProperty('id');
  });

  it('holds the inventory the hold is for', async () => {
    const before = await bookedOn(NIGHTS[0]);
    await bookPublic(validBooking(NIGHTS[0], addDays(NIGHTS[0], 1))).expect(201);
    expect(await bookedOn(NIGHTS[0])).toBe(before + 1);
  });

  it('prices the booking itself rather than believing the request', async () => {
    const response = await bookPublic(
      validBooking(NIGHTS[0], addDays(NIGHTS[0], 2), {
        // A booking engine that accepted an amount would sell rooms for a baht.
        total: 1,
        stays: [{ roomTypeId: deluxeId, ratePlanId: deluxePlanId, adults: 2, amount: 1 }],
      }),
    );

    // Rejected outright by the strict schema rather than quietly ignored.
    expect(response.status).toBe(422);
  });

  it('refuses to sell a night that is stopped', async () => {
    await pool.query(
      `UPDATE inventory_days SET stop_sell = true WHERE room_type_id = $1 AND date = $2`,
      [deluxeId, NIGHTS[0]],
    );

    // 422 rather than 409: a stopped night is a restriction the hotel set, not
    // a race for the last room. The booking path already tells the two apart
    // and the public endpoint inherits that distinction rather than flattening
    // it into "conflict".
    const response = await bookPublic(validBooking(NIGHTS[0], addDays(NIGHTS[0], 1))).expect(422);
    expect(JSON.stringify(response.body)).toMatch(/stop|restrict/i);
  });

  it('refuses a room type belonging to another property', async () => {
    const otherRoomType = crypto.randomUUID();
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'OTH', 'Somebody Else')`,
      [otherRoomType, orgId, propertyId],
    );

    await bookPublic(
      validBooking(NIGHTS[0], addDays(NIGHTS[0], 1), {
        stays: [{ roomTypeId: otherRoomType, ratePlanId: deluxePlanId, adults: 2 }],
      }),
    ).expect(422);
  });

  it('demands an address, because nothing else can reach the guest', async () => {
    await bookPublic({
      guest: { name: 'Ploy Sukhum' },
      checkIn: NIGHTS[0],
      checkOut: addDays(NIGHTS[0], 1),
      stays: [{ roomTypeId: deluxeId, ratePlanId: deluxePlanId, adults: 2 }],
    }).expect(422);
  });

  it('refuses to book out a hotel in one request', async () => {
    await bookPublic(
      validBooking(NIGHTS[0], addDays(NIGHTS[0], 1), {
        stays: Array.from({ length: 6 }, () => ({
          roomTypeId: deluxeId,
          ratePlanId: deluxePlanId,
          adults: 2,
        })),
      }),
    ).expect(422);
  });

  describe('deposit', () => {
    async function hold(): Promise<string> {
      const response = await bookPublic(validBooking(NIGHTS[0], addDays(NIGHTS[0], 1))).expect(201);
      return response.body.code as string;
    }

    it('says the hotel takes no cards rather than declining one', async () => {
      const code = await hold();

      const response = await request(app.getHttpServer())
        .post(publicUrl(`/bookings/${code}/deposit`))
        .send({ token: 'tokn_test_whatever' })
        .expect(200);

      // Telling a guest their card was declined when the hotel never had a
      // provider would be a lie about the hotel's own setup.
      expect(response.body.status).toBe('UNAVAILABLE');
      expect(response.body.reason).toMatch(/does not take card payments/i);
    });

    it('leaves the booking held so a human can still confirm it', async () => {
      const code = await hold();
      await request(app.getHttpServer())
        .post(publicUrl(`/bookings/${code}/deposit`))
        .send({ token: 'tokn_test_whatever' })
        .expect(200);

      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM reservations WHERE code = $1',
        [code],
      );
      // Bank transfer then a human confirming is how most small Thai hotels
      // already work.
      expect(rows[0]?.status).toBe('PENDING');
    });

    it('refuses to charge a booking that is not awaiting payment', async () => {
      const code = await hold();
      await pool.query(`UPDATE reservations SET status = 'CONFIRMED' WHERE code = $1`, [code]);

      // With nothing but a booking code, this would otherwise be a way to bill
      // a stranger's card twice.
      await request(app.getHttpServer())
        .post(publicUrl(`/bookings/${code}/deposit`))
        .send({ token: 'tokn_test_whatever' })
        .expect(409);
    });

    it('refuses a booking code from another property', async () => {
      const code = await hold();
      await request(app.getHttpServer())
        .post(`/api/v1/public/${orgSlug}/NOPE/bookings/${code}/deposit`)
        .send({ token: 'tokn_test_whatever' })
        .expect(404);
    });

    it('refuses a booking code nobody issued', async () => {
      await request(app.getHttpServer())
        .post(publicUrl('/bookings/NOSUCHCODE/deposit'))
        .send({ token: 'tokn_test_whatever' })
        .expect(404);
    });
  });

  it('will not serve a property whose organization has been suspended', async () => {
    await pool.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [orgId]);
    try {
      // Its bookings would be taken by a hotel that is no longer a customer.
      await request(app.getHttpServer()).get(publicUrl()).expect(404);
      await searchPublic(NIGHTS[0], addDays(NIGHTS[0], 1)).expect(404);
    } finally {
      await pool.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = $1`, [orgId]);
    }
  });
});
