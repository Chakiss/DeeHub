/**
 * The reservation detail endpoint, against real PostgreSQL.
 *
 * This read used to return only what the write path happened to load — a code,
 * a status and a list of dates. The detail screen has to answer "who is this,
 * what did they book and what were they quoted", so these check the fields that
 * make it usable, and the two joins that could silently empty it.
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
    'DATABASE_URL is not set in CI. Reservation e2e tests must run against Postgres.',
  );
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Reservation detail', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'reservation-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `rs-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const secondPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `rsx-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();
  const otherRoomTypeId = crypto.randomUUID();
  const otherRatePlanId = crypto.randomUUID();

  let token = '';

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

    for (const [org, slug] of [
      [orgId, orgSlug],
      [otherOrgId, otherOrgSlug],
    ] as const) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
        org,
        slug,
      ]);
    }
    for (const [property, org, code] of [
      [propertyId, orgId, 'MAIN'],
      [secondPropertyId, orgId, 'SECOND'],
      [otherPropertyId, otherOrgId, 'MAIN'],
    ] as const) {
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, $3, 'Detail Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
        [property, org, code],
      );
    }

    for (const [roomType, ratePlan, org, property] of [
      [deluxeId, ratePlanId, orgId, propertyId],
      [otherRoomTypeId, otherRatePlanId, otherOrgId, otherPropertyId],
    ] as const) {
      await pool.query(
        `INSERT INTO room_types (id, organization_id, property_id, code, name)
         VALUES ($1, $2, $3, 'DLX', 'Deluxe Sea View')`,
        [roomType, org, property],
      );
      await pool.query(
        `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
         VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
        [ratePlan, org, property, roomType],
      );
    }

    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $3)`,
      [
        managerId,
        orgId,
        `manager-${orgSlug}@e2e.test`,
        await new ScryptPasswordHasher().hash(PASSWORD),
      ],
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
    for (const org of [orgId, otherOrgId]) {
      for (const table of [
        'audit_logs',
        'reservation_stay_nights',
        'reservation_stays',
        'reservations',
        'guests',
        'physical_rooms',
        'rate_plans',
        'room_types',
        'memberships',
        'refresh_tokens',
        'users',
        'properties',
      ]) {
        await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
      }
      await pool.query('DELETE FROM organizations WHERE id = $1', [org]);
    }
    await app.close();
  });

  beforeEach(async () => {
    for (const org of [orgId, otherOrgId]) {
      for (const table of [
        'reservation_stay_nights',
        'reservation_stays',
        'reservations',
        'physical_rooms',
      ]) {
        await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
      }
    }
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /**
   * Written straight to the tables. The booking flow is covered by its own
   * integration test; what matters here is what comes back out.
   */
  async function seedReservation(
    options: {
      org?: string;
      property?: string;
      roomType?: string;
      ratePlan?: string;
      assignedRoomId?: string | null;
      status?: string;
      nights?: readonly { date: string; amountMinor: number }[];
    } = {},
  ): Promise<{ reservationId: string; stayId: string }> {
    const org = options.org ?? orgId;
    const property = options.property ?? propertyId;
    const roomType = options.roomType ?? deluxeId;
    const ratePlan = options.ratePlan ?? ratePlanId;
    const nights = options.nights ?? [
      { date: '2028-03-01', amountMinor: 120000 },
      { date: '2028-03-02', amountMinor: 150000 },
    ];
    const subtotal = nights.reduce((sum, night) => sum + night.amountMinor, 0);

    const reservationId = crypto.randomUUID();
    const stayId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO reservations
         (id, organization_id, property_id, code, status, source, booker_name, booker_email,
          booker_phone, special_requests, currency, subtotal_minor, tax_minor,
          service_charge_minor, total_minor, version)
       VALUES ($1, $2, $3, $4, $5, 'PHONE', 'Somchai Prasert', 'somchai@example.com',
               '+66812345678', 'High floor, away from the lift', 'THB', $6, $7, $8, $9, 3)`,
      [
        reservationId,
        org,
        property,
        `RS-${stayId.slice(0, 6).toUpperCase()}`,
        options.status ?? 'CONFIRMED',
        subtotal,
        Math.round(subtotal * 0.07),
        Math.round(subtotal * 0.1),
        subtotal + Math.round(subtotal * 0.07) + Math.round(subtotal * 0.1),
      ],
    );

    await pool.query(
      `INSERT INTO reservation_stays
         (id, organization_id, property_id, reservation_id, room_type_id, rate_plan_id,
          check_in, check_out, adults, children, guest_name, assigned_room_id, subtotal_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2, 1, 'Somchai Prasert', $9, $10)`,
      [
        stayId,
        org,
        property,
        reservationId,
        roomType,
        ratePlan,
        nights[0]!.date,
        addDay(nights[nights.length - 1]!.date),
        options.assignedRoomId ?? null,
        subtotal,
      ],
    );

    for (const night of nights) {
      await pool.query(
        `INSERT INTO reservation_stay_nights
           (stay_id, date, organization_id, reservation_id, property_id, room_type_id,
            amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'THB')`,
        [stayId, night.date, org, reservationId, property, roomType, night.amountMinor],
      );
    }

    return { reservationId, stayId };
  }

  function get(reservationId: string, property = propertyId) {
    return request(app.getHttpServer())
      .get(`/api/v1/properties/${property}/reservations/${reservationId}`)
      .set(auth());
  }

  it('returns the booker, the money breakdown and the version', async () => {
    const { reservationId } = await seedReservation();

    const response = await get(reservationId).expect(200);

    expect(response.body).toMatchObject({
      id: reservationId,
      status: 'CONFIRMED',
      source: 'PHONE',
      bookerName: 'Somchai Prasert',
      bookerEmail: 'somchai@example.com',
      bookerPhone: '+66812345678',
      specialRequests: 'High floor, away from the lift',
      currency: 'THB',
      // Echoed back on every mutation; without it the buttons cannot lock.
      version: 3,
    });
    expect(response.body.subtotal).toEqual({ amount: 270000, currency: 'THB' });
    expect(response.body.tax).toEqual({ amount: 18900, currency: 'THB' });
    expect(response.body.serviceCharge).toEqual({ amount: 27000, currency: 'THB' });
    expect(response.body.total).toEqual({ amount: 315900, currency: 'THB' });
  });

  /**
   * The room type is joined in. It is the only human-readable thing on a stay —
   * a front desk cannot act on a UUID.
   */
  it('names the room type rather than returning its id alone', async () => {
    const { reservationId } = await seedReservation();
    const response = await get(reservationId).expect(200);

    expect(response.body.stays[0]).toMatchObject({
      roomTypeId: deluxeId,
      roomTypeName: 'Deluxe Sea View',
      adults: 2,
      children: 1,
      guestName: 'Somchai Prasert',
    });
  });

  /**
   * The physical room join must be a LEFT one. No room is assigned until
   * check-in, so an inner join would return zero stays for every future
   * booking — the reservation would look empty rather than unassigned.
   */
  it('still returns the stay when no room is assigned yet', async () => {
    const { reservationId, stayId } = await seedReservation({ assignedRoomId: null });

    const response = await get(reservationId).expect(200);

    expect(response.body.stays).toHaveLength(1);
    expect(response.body.stays[0]).toMatchObject({
      id: stayId,
      assignedRoomId: null,
      assignedRoomNumber: null,
    });
  });

  it('shows the room number once a room is assigned', async () => {
    const roomId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
       VALUES ($1, $2, $3, $4, '1204')`,
      [roomId, orgId, propertyId, deluxeId],
    );
    const { reservationId } = await seedReservation({ assignedRoomId: roomId });

    const response = await get(reservationId).expect(200);
    expect(response.body.stays[0]).toMatchObject({
      assignedRoomId: roomId,
      assignedRoomNumber: '1204',
    });
  });

  /**
   * Prices are frozen at booking time. Reading them back from the rate plan
   * would rewrite the quote whenever rates move, which is the one thing a
   * booking record must never do.
   */
  it('returns the price each night was sold at, in order', async () => {
    const { reservationId } = await seedReservation({
      nights: [
        { date: '2028-05-10', amountMinor: 100000 },
        { date: '2028-05-11', amountMinor: 250000 },
        { date: '2028-05-12', amountMinor: 100000 },
      ],
    });

    const response = await get(reservationId).expect(200);
    expect(response.body.stays[0].nights).toEqual([
      { date: '2028-05-10', amount: 100000 },
      { date: '2028-05-11', amount: 250000 },
      { date: '2028-05-12', amount: 100000 },
    ]);
  });

  it('returns 404 for a booking that belongs to another property', async () => {
    const { reservationId } = await seedReservation();
    await get(reservationId, secondPropertyId).expect(404);
  });

  it('returns 404 for a booking in another organization', async () => {
    const { reservationId } = await seedReservation({
      org: otherOrgId,
      property: otherPropertyId,
      roomType: otherRoomTypeId,
      ratePlan: otherRatePlanId,
    });
    await get(reservationId).expect(404);
    await get(reservationId, otherPropertyId).expect(404);
  });

  it('reports cancellation on a cancelled booking', async () => {
    const { reservationId } = await seedReservation({ status: 'CANCELLED' });
    await pool.query(
      `UPDATE reservations SET cancelled_at = now(), cancellation_reason = 'Guest called'
        WHERE id = $1`,
      [reservationId],
    );

    const response = await get(reservationId).expect(200);
    expect(response.body.status).toBe('CANCELLED');
    expect(response.body.cancellationReason).toBe('Guest called');
    expect(response.body.cancelledAt).not.toBeNull();
  });
});

/** Check-out is the morning after the last night (half-open `[)` nights). */
function addDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
