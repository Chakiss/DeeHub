/**
 * Removing nightly prices, against real PostgreSQL.
 *
 * Until this endpoint existed a mis-typed rate could not be taken back, only
 * overwritten — and the obvious workaround, typing 0, makes the room sellable
 * FOR FREE rather than unsellable. These check that removal actually removes,
 * that it reports how much of the hotel it just took off sale, and that it
 * never touches what a guest was already quoted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Rate e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/** A Wed–Sun run, so weekday filtering has something to bite on. */
const NIGHTS = ['2030-09-04', '2030-09-05', '2030-09-06', '2030-09-07', '2030-09-08'] as const;
const RATE_MINOR = 300000;

describeIfDb('Removing rates', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'delete-rates-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `dr-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const barPlanId = crypto.randomUUID();
  /** A second plan on the SAME room type: losing one must not orphan the night. */
  const nrfPlanId = crypto.randomUUID();
  const foreignPlanId = crypto.randomUUID();
  const foreignRoomTypeId = crypto.randomUUID();
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
    const hash = await new ScryptPasswordHasher().hash(PASSWORD);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      orgId,
      orgSlug,
    ]);
    for (const [property, code] of [
      [propertyId, 'MAIN'],
      [otherPropertyId, 'SECOND'],
    ] as const) {
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, $3, 'Rate Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
        [property, orgId, code],
      );
    }

    for (const [id, property, code, name] of [
      [roomTypeId, propertyId, 'TRV', 'Triple River View'],
      [foreignRoomTypeId, otherPropertyId, 'TRV', 'Other Triple'],
    ] as const) {
      await pool.query(
        `INSERT INTO room_types (id, organization_id, property_id, code, name,
                                 standard_occupancy, max_occupancy, max_adults, max_children)
         VALUES ($1, $2, $3, $4, $5, 2, 4, 3, 2)`,
        [id, orgId, property, code, name],
      );
    }

    for (const [id, property, roomType, code] of [
      [barPlanId, propertyId, roomTypeId, 'BAR'],
      [nrfPlanId, propertyId, roomTypeId, 'NRF'],
      [foreignPlanId, otherPropertyId, foreignRoomTypeId, 'BAR'],
    ] as const) {
      await pool.query(
        `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
         VALUES ($1, $2, $3, $4, $5, 'Plan')`,
        [id, orgId, property, roomType, code],
      );
    }

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
    // audit_logs and outbox_events too: these tests assert on entries keyed by
    // the rate plan, which is shared across every test in this file. Without
    // clearing them each one would read the previous test's rows.
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
    await pool.query('UPDATE rate_plans SET is_active = TRUE WHERE organization_id = $1', [orgId]);

    for (const date of NIGHTS) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 3)`,
        [orgId, propertyId, roomTypeId, date],
      );
      // Only the BAR plan is priced by default. Occupancies 1..3.
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
          [orgId, propertyId, barPlanId, date, occupancy, RATE_MINOR],
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

  function remove(deletions: unknown[]) {
    return request(app.getHttpServer())
      .delete(`/api/v1/properties/${propertyId}/rates`)
      .set(auth())
      .send({ deletions });
  }

  async function priceCount(ratePlanId = barPlanId): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM rate_days WHERE rate_plan_id = $1',
      [ratePlanId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  it('removes every price in the range', async () => {
    expect(await priceCount()).toBe(15);

    const response = await remove([
      { ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-06' },
    ]).expect(200);

    // Two nights (the range is half-open) at three occupancies.
    expect(response.body.pricesRemoved).toBe(6);
    expect(await priceCount()).toBe(9);
  });

  /**
   * The whole reason this endpoint exists: after removing, the night must be
   * UNSELLABLE, not sellable at zero. Typing 0 was the only workaround before
   * and it gives the room away.
   */
  it('makes the night unsellable rather than free', async () => {
    await remove([{ ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-05' }]).expect(200);

    const { rows } = await pool.query(
      `SELECT amount_minor FROM rate_days WHERE rate_plan_id = $1 AND date = '2030-09-04'`,
      [barPlanId],
    );
    expect(rows).toHaveLength(0);

    // And a booking for that night is refused, not sold for nothing.
    const booking = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'PHONE',
        booker: { name: 'Somchai' },
        stays: [
          {
            roomTypeId,
            ratePlanId: barPlanId,
            checkIn: '2030-09-04',
            checkOut: '2030-09-05',
            adults: 2,
          },
        ],
      })
      .expect(422);
    expect(booking.body.error.code).toBe('RATE_MISSING');
  });

  it('removes only the named occupancy', async () => {
    const response = await remove([
      { ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-09', occupancies: [3] },
    ]).expect(200);

    expect(response.body.pricesRemoved).toBe(5);
    const { rows } = await pool.query<{ occupancy: number }>(
      'SELECT DISTINCT occupancy FROM rate_days WHERE rate_plan_id = $1 ORDER BY occupancy',
      [barPlanId],
    );
    expect(rows.map((row) => row.occupancy)).toEqual([1, 2]);
  });

  it('removes only the named weekdays', async () => {
    // 2030-09-07 is a Saturday, 2030-09-08 a Sunday.
    const response = await remove([
      {
        ratePlanId: barPlanId,
        from: '2030-09-04',
        to: '2030-09-09',
        daysOfWeek: ['SAT', 'SUN'],
      },
    ]).expect(200);

    expect(response.body.pricesRemoved).toBe(6);
    const { rows } = await pool.query<{ date: string }>(
      'SELECT DISTINCT date::text FROM rate_days WHERE rate_plan_id = $1 ORDER BY date',
      [barPlanId],
    );
    expect(rows.map((row) => row.date)).toEqual(['2030-09-04', '2030-09-05', '2030-09-06']);
  });

  /**
   * The number a manager needs. Removing a price on a night that still has
   * allotment takes the hotel off sale, silently — a booking is just refused.
   */
  it('reports how many nights it just took off sale', async () => {
    const response = await remove([
      { ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-07' },
    ]).expect(200);

    expect(response.body.nightsNowUnsellable).toBe(3);
  });

  /**
   * Counting per rate plan would over-report. A hotel selling both a refundable
   * and a non-refundable plan can lose one and still sell the night.
   */
  it('does not count a night another active plan still prices', async () => {
    for (const date of NIGHTS) {
      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                occupancy, amount_minor, currency)
         VALUES ($1, $2, $3, $4, 2, $5, 'THB')`,
        [orgId, propertyId, nrfPlanId, date, RATE_MINOR],
      );
    }

    const response = await remove([
      { ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-07' },
    ]).expect(200);

    expect(response.body.pricesRemoved).toBe(9);
    expect(response.body.nightsNowUnsellable).toBe(0);
  });

  /** A night with no allotment was not on sale to begin with. */
  it('does not count a night that had no allotment anyway', async () => {
    await pool.query(
      `UPDATE inventory_days SET allotment = 0 WHERE room_type_id = $1 AND organization_id = $2`,
      [roomTypeId, orgId],
    );

    const response = await remove([
      { ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-07' },
    ]).expect(200);

    expect(response.body.pricesRemoved).toBe(9);
    expect(response.body.nightsNowUnsellable).toBe(0);
  });

  /**
   * Prices are frozen at booking time. Removing a rate must never rewrite what
   * a guest was already quoted.
   */
  it('leaves an existing booking at the price it was sold', async () => {
    const booking = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'PHONE',
        booker: { name: 'Ploy' },
        stays: [
          {
            roomTypeId,
            ratePlanId: barPlanId,
            checkIn: '2030-09-04',
            checkOut: '2030-09-06',
            adults: 2,
          },
        ],
      })
      .expect(201);

    await remove([{ ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-09' }]).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${booking.body.id as string}`)
      .set(auth())
      .expect(200);

    expect(detail.body.subtotal.amount).toBe(RATE_MINOR * 2);
    expect(detail.body.stays[0].nights).toHaveLength(2);
    expect(detail.body.stays[0].nights[0].amount).toBe(RATE_MINOR);
  });

  it('records what was removed, so it can be re-entered', async () => {
    await remove([
      { ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-05', occupancies: [2] },
    ]).expect(200);

    const { rows } = await pool.query<{
      before: { prices: { date: string; occupancy: number; amount: number }[]; truncated: boolean };
      after: { pricesRemoved: number };
    }>(
      `SELECT before, after FROM audit_logs
        WHERE entity_id = $1 AND action = 'rate.deleted'`,
      [barPlanId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.before.prices).toEqual([
      { date: '2030-09-04', occupancy: 2, amount: RATE_MINOR },
    ]);
    expect(rows[0]?.before.truncated).toBe(false);
    expect(rows[0]?.after.pricesRemoved).toBe(1);
  });

  it('tells channels to re-read, so an OTA stops selling the night', async () => {
    await remove([{ ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-06' }]).expect(200);

    const { rows } = await pool.query<{ payload: { roomTypeId: string; from: string } }>(
      `SELECT payload FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'rate.changed'`,
      [barPlanId],
    );
    expect(rows).toHaveLength(1);
    // The relay keys the dirty ARI window by room type, not rate plan.
    expect(rows[0]?.payload.roomTypeId).toBe(roomTypeId);
    expect(rows[0]?.payload.from).toBe('2030-09-04');
  });

  it('succeeds harmlessly when there is nothing to remove', async () => {
    const response = await remove([
      { ratePlanId: barPlanId, from: '2031-01-01', to: '2031-01-05' },
    ]).expect(200);

    expect(response.body.pricesRemoved).toBe(0);
    expect(response.body.nightsNowUnsellable).toBe(0);
    // Nothing happened, so nothing is audited.
    const { rows } = await pool.query(
      `SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'rate.deleted'`,
      [barPlanId],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a rate plan belonging to another property', async () => {
    await remove([{ ratePlanId: foreignPlanId, from: '2030-09-04', to: '2030-09-06' }]).expect(404);
  });

  it('refuses a reader who lacks rate:update', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/properties/${propertyId}/rates`)
      .set({ Authorization: `Bearer ${readerToken}` })
      .send({ deletions: [{ ratePlanId: barPlanId, from: '2030-09-04', to: '2030-09-06' }] })
      .expect(403);
  });

  it('rejects a backwards range as a client error', async () => {
    await remove([{ ratePlanId: barPlanId, from: '2030-09-06', to: '2030-09-04' }]).expect(422);
  });
});
