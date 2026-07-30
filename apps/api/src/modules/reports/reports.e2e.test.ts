/**
 * Performance reporting against real PostgreSQL.
 *
 * Most of these pin down the denominators. An owner compares occupancy against
 * an STR report or their previous PMS, and the first figure that does not match
 * costs trust in every other number on the page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Report e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Performance report', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'reports-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `rep-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  const DATES = ['2028-03-01', '2028-03-02', '2028-03-03'];
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

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      orgId,
      orgSlug,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
       VALUES ($1, $2, 'MAIN', 'Report Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe')`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );
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
    for (const table of [
      'audit_logs',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'inventory_days',
      'physical_rooms',
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
    await pool.query('DELETE FROM reservation_stay_nights WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservation_stays WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM physical_rooms WHERE organization_id = $1', [orgId]);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function openInventory(allotment: number): Promise<void> {
    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [orgId, propertyId, roomTypeId, date, allotment],
      );
    }
  }

  async function addRooms(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await pool.query(
        `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), orgId, propertyId, roomTypeId, `R${String(i + 1)}`],
      );
    }
  }

  /** One room sold for the given nights at the given nightly rate. */
  async function sell(nights: string[], amountMinor: number, status = 'CONFIRMED'): Promise<void> {
    const reservationId = crypto.randomUUID();
    const stayId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO reservations (id, organization_id, property_id, code, status, source,
                                 booker_name, currency)
       VALUES ($1, $2, $3, $4, $5, 'WALK_IN', 'Guest', 'THB')`,
      [reservationId, orgId, propertyId, `RP-${stayId.slice(0, 6).toUpperCase()}`, status],
    );
    await pool.query(
      `INSERT INTO reservation_stays
         (id, organization_id, property_id, reservation_id, room_type_id, rate_plan_id,
          check_in, check_out, adults)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2)`,
      [
        stayId,
        orgId,
        propertyId,
        reservationId,
        roomTypeId,
        ratePlanId,
        nights[0],
        // check_out is the morning after the last night.
        new Date(`${nights[nights.length - 1]!}T00:00:00Z`)
          .toISOString()
          .slice(0, 10)
          .replace(/(\d{2})$/, (day) => String(Number(day) + 1).padStart(2, '0')),
      ],
    );
    for (const date of nights) {
      await pool.query(
        `INSERT INTO reservation_stay_nights
           (stay_id, date, organization_id, reservation_id, property_id, room_type_id,
            amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'THB')`,
        [stayId, date, orgId, reservationId, propertyId, roomTypeId, amountMinor],
      );
    }
  }

  function get(from = DATES[0]!, to = '2028-03-04') {
    return request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reports/performance?from=${from}&to=${to}`)
      .set(auth());
  }

  it('counts rooms sold and revenue per night', async () => {
    await openInventory(5);
    await sell([DATES[0]!, DATES[1]!], 250000);
    await sell([DATES[0]!], 300000);

    const response = await get().expect(200);

    const first = response.body.nights[0];
    expect(first).toMatchObject({ date: DATES[0], roomsSold: 2, revenueMinor: 550000 });
    expect(response.body.nights[1]).toMatchObject({ roomsSold: 1, revenueMinor: 250000 });
    expect(response.body.nights[2]).toMatchObject({ roomsSold: 0, revenueMinor: 0 });
    expect(response.body.totals).toMatchObject({ roomsSold: 3, revenueMinor: 800000 });
  });

  // Revenue over rooms sold. No denominator choice to get wrong.
  it('computes ADR from revenue over rooms sold', async () => {
    await openInventory(5);
    await sell([DATES[0]!], 200000);
    await sell([DATES[0]!], 400000);

    const response = await get().expect(200);
    expect(response.body.nights[0].adrMinor).toBe(300000);
  });

  it('reports no ADR rather than zero when nothing sold', async () => {
    await openInventory(5);
    const response = await get().expect(200);
    // An average of nothing is not zero.
    expect(response.body.nights[0].adrMinor).toBeNull();
    expect(response.body.totals.adrMinor).toBeNull();
  });

  /**
   * The decision this report rests on. Occupancy and RevPAR are the INDUSTRY
   * definitions, measured against physical rooms — the figure an owner compares
   * against an STR report — while sell-through answers "how much of what I
   * offered did I sell", which is the channel-manager question.
   */
  it('measures occupancy against physical rooms and sell-through against allotment', async () => {
    await openInventory(4);
    await addRooms(10);
    await sell([DATES[0]!], 200000);
    await sell([DATES[0]!], 200000);

    const response = await get().expect(200);
    const first = response.body.nights[0];

    expect(response.body.roomsAvailable).toBe(10);
    // 2 of 10 rooms.
    expect(first.occupancy).toBeCloseTo(0.2, 5);
    // 2 of the 4 offered.
    expect(first.sellThrough).toBeCloseTo(0.5, 5);
    // 400000 over 10 rooms.
    expect(first.revParMinor).toBe(40000);
  });

  /**
   * A property can run without entering a single room — allotment is what it
   * sells. Reporting 0% occupancy would be a lie; reporting nothing is honest.
   */
  it('reports no occupancy at all when no rooms are set up', async () => {
    await openInventory(4);
    await sell([DATES[0]!], 200000);

    const response = await get().expect(200);
    expect(response.body.roomsAvailable).toBeNull();
    expect(response.body.nights[0].occupancy).toBeNull();
    expect(response.body.nights[0].revParMinor).toBeNull();
    // The one that is always answerable still is.
    expect(response.body.nights[0].sellThrough).toBeCloseTo(0.25, 5);
  });

  it('excludes cancelled bookings', async () => {
    await openInventory(5);
    await sell([DATES[0]!], 200000, 'CANCELLED');
    await sell([DATES[0]!], 300000);

    const response = await get().expect(200);
    expect(response.body.nights[0]).toMatchObject({ roomsSold: 1, revenueMinor: 300000 });
  });

  // The same set the inventory grid counts as booked. A report that disagreed
  // with the grid would make an operator distrust both.
  it('counts a checked-out stay, matching the grid', async () => {
    await openInventory(5);
    await sell([DATES[0]!], 250000, 'CHECKED_OUT');

    const response = await get().expect(200);
    expect(response.body.nights[0].roomsSold).toBe(1);
  });

  it('totals occupancy over room-nights, not rooms', async () => {
    await openInventory(5);
    await addRooms(2);
    // One room for all three nights: 3 of the 6 room-nights on offer.
    await sell(DATES, 100000);

    const response = await get().expect(200);
    expect(response.body.totals.occupancy).toBeCloseTo(0.5, 5);
  });

  it('rejects an inverted or oversized range', async () => {
    await get('2028-03-10', '2028-03-01').expect(422);
    await get('2026-01-01', '2028-01-01').expect(422);
  });
});
