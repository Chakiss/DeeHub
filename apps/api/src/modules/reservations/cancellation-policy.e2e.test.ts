/**
 * The cancellation policy frozen onto a stay when a booking is made, against
 * real PostgreSQL.
 *
 * The rate plan's policy is the hotel's CURRENT terms; the stay's copy is what
 * this guest was promised. These prove the copy is taken at booking, is not
 * touched by later edits to the plan, and is left empty where the terms are
 * not ours to state (OTA and travel-agent bookings).
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
    'DATABASE_URL is not set in CI. Cancellation policy e2e tests must run against Postgres.',
  );
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

const NIGHTS = ['2031-08-01', '2031-08-02', '2031-08-03'] as const;

describeIfDb('Cancellation policy on a booking', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'policy-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `cp-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const flexPlanId = crypto.randomUUID();
  const nrfPlanId = crypto.randomUUID();
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
         VALUES ($1, $2, $3, 'Policy Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
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
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name,
                               cancellation_notice_hours, cancellation_refund_percent)
       VALUES ($1, $2, $3, $4, 'BAR-DLX', 'Best Available', 48, 70)`,
      [deluxePlanId, orgId, propertyId, deluxeId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name,
                               cancellation_notice_hours, cancellation_refund_percent)
       VALUES ($1, $2, $3, $4, 'FLEX-DLX', 'Flexible', 72, 100)`,
      [flexPlanId, orgId, propertyId, deluxeId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name, is_refundable)
       VALUES ($1, $2, $3, $4, 'NRF-DLX', 'Non-refundable', false)`,
      [nrfPlanId, orgId, propertyId, deluxeId],
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
      'booking_sources',
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
    await pool.query(
      `UPDATE rate_plans SET is_refundable = true, cancellation_notice_hours = 48,
              cancellation_refund_percent = 70 WHERE id = $1`,
      [deluxePlanId],
    );
    await pool.query(
      `UPDATE rate_plans SET cancellation_notice_hours = 72, cancellation_refund_percent = 100
        WHERE id = $1`,
      [flexPlanId],
    );
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
      for (const plan of [deluxePlanId, flexPlanId, nrfPlanId]) {
        for (const occupancy of [1, 2, 3]) {
          await pool.query(
            `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                    occupancy, amount_minor, currency)
             VALUES ($1, $2, $3, $4, $5, 120000, 'THB')`,
            [orgId, propertyId, plan, date, occupancy],
          );
        }
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

  async function bookStays(
    source: string,
    stays: { ratePlanId: string; checkIn?: string; checkOut?: string }[],
    extra: Record<string, unknown> = {},
  ) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source,
        status: 'CONFIRMED',
        booker: { name: 'Krissada Laohongkiat', email: 'krissada@example.com' },
        stays: stays.map((stay) => ({
          roomTypeId: deluxeId,
          checkIn: NIGHTS[0],
          checkOut: NIGHTS[2],
          adults: 1,
          ...stay,
        })),
        ...extra,
      })
      .expect(201);
    return response.body as { id: string; stays: { id: string }[] };
  }

  async function book(source: string, extra: Record<string, unknown> = {}): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source,
        status: 'CONFIRMED',
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
        ...extra,
      })
      .expect(201);
    return response.body.id as string;
  }

  async function frozen(reservationId: string) {
    const { rows } = await pool.query<{
      cancellation_notice_hours: number | null;
      cancellation_refund_percent: number | null;
    }>(
      `SELECT cancellation_notice_hours, cancellation_refund_percent
         FROM reservation_stays WHERE reservation_id = $1`,
      [reservationId],
    );
    return rows.map((row) => [row.cancellation_notice_hours, row.cancellation_refund_percent]);
  }

  it("freezes the plan's policy onto a direct booking", async () => {
    const id = await book('DIRECT');
    expect(await frozen(id)).toEqual([[48, 70]]);
  });

  it('freezes it for phone and walk-in bookings too', async () => {
    expect(await frozen(await book('PHONE'))).toEqual([[48, 70]]);
    expect(await frozen(await book('WALK_IN'))).toEqual([[48, 70]]);
  });

  it('freezes each stay from its own plan when a booking mixes plans', async () => {
    const booking = await bookStays('DIRECT', [
      { ratePlanId: flexPlanId },
      { ratePlanId: deluxePlanId },
    ]);
    expect((await frozen(booking.id)).sort()).toEqual([
      [48, 70],
      [72, 100],
    ]);
  });

  describe('changing the rate plan of a stay', () => {
    async function modify(reservationId: string, stayId: string, body: Record<string, unknown>) {
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
        .set(auth())
        .expect(200);
      return request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}`)
        .set(auth())
        .send({ version: detail.body.version as number, ...body })
        .expect(200);
    }

    it('re-freezes to 0 / 0 when the new plan is not refundable', async () => {
      const booking = await bookStays('DIRECT', [{ ratePlanId: deluxePlanId }]);
      expect(await frozen(booking.id)).toEqual([[48, 70]]);

      await modify(booking.id, booking.stays[0]!.id, { ratePlanId: nrfPlanId });
      expect(await frozen(booking.id)).toEqual([[0, 0]]);
    });

    it('re-freezes from the new plan when it is refundable', async () => {
      const booking = await bookStays('DIRECT', [{ ratePlanId: deluxePlanId }]);
      await modify(booking.id, booking.stays[0]!.id, { ratePlanId: flexPlanId });
      expect(await frozen(booking.id)).toEqual([[72, 100]]);
    });

    it('leaves the frozen terms alone when only the dates change', async () => {
      const booking = await bookStays('DIRECT', [{ ratePlanId: deluxePlanId }]);
      // The plan has since been edited; a dates-only change must not pick that up.
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${deluxePlanId}`)
        .set(auth())
        .send({ cancellationNoticeHours: 0, cancellationRefundPercent: 100 })
        .expect(200);

      await modify(booking.id, booking.stays[0]!.id, { checkOut: NIGHTS[1] });
      expect(await frozen(booking.id)).toEqual([[48, 70]]);
    });
  });

  it('will not let a read-only user or another property change a plan', async () => {
    const url = `/api/v1/properties/${propertyId}/rate-plans/${deluxePlanId}`;
    await request(app.getHttpServer())
      .patch(url)
      .set({ Authorization: `Bearer ${readerToken}` })
      .send({ cancellationRefundPercent: 0 })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${otherPropertyId}/rate-plans/${deluxePlanId}`)
      .set(auth())
      .send({ cancellationRefundPercent: 0 })
      .expect(404);

    const { rows } = await pool.query<{ cancellation_refund_percent: number }>(
      'SELECT cancellation_refund_percent FROM rate_plans WHERE id = $1',
      [deluxePlanId],
    );
    expect(rows[0]?.cancellation_refund_percent).toBe(70);
  });

  it('keeps the frozen values when the plan is edited afterwards', async () => {
    const id = await book('DIRECT');
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/rate-plans/${deluxePlanId}`)
      .set(auth())
      .send({ cancellationNoticeHours: 0, cancellationRefundPercent: 0 })
      .expect(200);

    expect(await frozen(id)).toEqual([[48, 70]]);
    // The next booking gets the new terms.
    expect(await frozen(await book('DIRECT'))).toEqual([[0, 0]]);
  });

  it('freezes an explicit 0 / 0 when the plan is not refundable', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/rate-plans/${deluxePlanId}`)
      .set(auth())
      .send({ isRefundable: false })
      .expect(200);

    expect(await frozen(await book('DIRECT'))).toEqual([[0, 0]]);
  });

  it('records nothing for an OTA or travel-agent booking', async () => {
    for (const kind of ['OTA', 'TRAVEL_AGENT'] as const) {
      const sourceId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO booking_sources (id, organization_id, property_id, name, kind)
         VALUES ($1, $2, $3, $4, $5)`,
        [sourceId, orgId, propertyId, `${kind} source`, kind],
      );
      const id = await book(kind, { bookingSourceId: sourceId });
      expect(await frozen(id)).toEqual([[null, null]]);
      await pool.query('DELETE FROM reservation_stay_nights WHERE reservation_id = $1', [id]);
      await pool.query('DELETE FROM reservation_stays WHERE reservation_id = $1', [id]);
      await pool.query('DELETE FROM reservations WHERE id = $1', [id]);
      await pool.query('DELETE FROM booking_sources WHERE id = $1', [sourceId]);
    }
  });
});
