/**
 * Marking a no-show, against real PostgreSQL: a CONFIRMED booking whose guest never
 * arrived closes, unused nights go back on sale, and nothing touches the folio.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. No-show e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Mark a booking no-show', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'no-show-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `ns-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  let token = '';
  let readerToken = '';
  const roomId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `nx-${otherOrgId.slice(0, 8)}`;
  let otherOrgToken = '';
  let dates: string[] = []; // today-1 .. today+4

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
      // No tax or service charge, so the booking total is exactly the nights.
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                                 tax_rate_bp, service_charge_rate_bp)
         VALUES ($1, $2, $3, 'Refund Hotel', 'Asia/Bangkok', 'THB', 'TH', 0, 0)`,
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
       VALUES ($1, $2, $3, $4, 'BAR-DLX', 'Best Available', 24, 50)`,
      [planId, orgId, propertyId, deluxeId],
    );

    const { rows } = await pool.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date + g, 'YYYY-MM-DD') AS d
         FROM generate_series(-1, 4) AS g ORDER BY g`,
    );
    dates = rows.map((row) => row.d);

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

    await pool.query(
      `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
       VALUES ($1, $2, $3, $4, '501')`,
      [roomId, orgId, propertyId, deluxeId],
    );

    // A second organization, for the tenant-boundary case.
    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      otherOrgId,
      otherOrgSlug,
    ]);
    const otherPropertyOfOtherOrg = crypto.randomUUID();
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
       VALUES ($1, $2, 'XORG', 'Other Org Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
      [otherPropertyOfOtherOrg, otherOrgId],
    );
    const outsiderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $3)`,
      [outsiderId, otherOrgId, `outsider-${otherOrgSlug}@e2e.test`, hash],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
       VALUES ($1, $2, $3, NULL, 'MANAGER')`,
      [crypto.randomUUID(), otherOrgId, outsiderId],
    );
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        organizationSlug: otherOrgSlug,
        email: `outsider-${otherOrgSlug}@e2e.test`,
        password: PASSWORD,
      })
      .expect(200);
    otherOrgToken = login.body.accessToken as string;

    token = await tokenFor(`manager-${orgSlug}@e2e.test`);
    readerToken = await tokenFor(`reader-${orgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'folio_payments',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'rate_days',
      'inventory_days',
      'rate_plans',
      'physical_rooms',
      'room_types',
      'memberships',
      'refresh_tokens',
      'users',
      'properties',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    for (const table of ['memberships', 'refresh_tokens', 'users', 'properties']) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [otherOrgId]);
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [otherOrgId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await app.close();
  });

  beforeEach(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'folio_payments',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'rate_days',
      'inventory_days',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    for (const date of dates) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 1)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 45000, 'THB')`,
          [orgId, propertyId, planId, date, occupancy],
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
  const base = (id: string, pid = propertyId) => `/api/v1/properties/${pid}/reservations/${id}`;

  /** Two nights from `checkIn` (dates index) at ฿450 = ฿900. */
  async function book(
    checkInIndex: number,
    status: 'CONFIRMED' | 'PENDING' = 'CONFIRMED',
    nights = 2,
  ): Promise<string> {
    return (await bookWithStay(checkInIndex, status, nights)).id;
  }

  async function bookWithStay(
    checkInIndex: number,
    status: 'CONFIRMED' | 'PENDING' = 'CONFIRMED',
    nights = 2,
  ): Promise<{ id: string; stayId: string }> {
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
            ratePlanId: planId,
            checkIn: dates[checkInIndex],
            checkOut: dates[checkInIndex + nights],
            adults: 1,
          },
        ],
      })
      .expect(201);
    return {
      id: response.body.id as string,
      stayId: (response.body.stays as { id: string }[])[0]!.id,
    };
  }

  async function version(id: string): Promise<number> {
    const detail = await request(app.getHttpServer()).get(base(id)).set(auth()).expect(200);
    return detail.body.version as number;
  }

  /** Resolves to the response and asserts its status, like supertest's `.expect`. */
  async function noShow(
    id: string,
    expected: number,
    body: Record<string, unknown> = {},
    who = auth(),
  ) {
    return request(app.getHttpServer())
      .post(`${base(id)}/no-show`)
      .set(who)
      .send({ version: await version(id), ...body })
      .expect(expected);
  }

  async function booked(date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      `SELECT booked FROM inventory_days
        WHERE organization_id = $1 AND room_type_id = $2 AND date = $3`,
      [orgId, deluxeId, date],
    );
    return Number(rows[0]!.booked);
  }

  async function availableOn(date: string): Promise<number> {
    const grid = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/inventory`)
      .query({ from: dates[0], to: dates[5], roomTypeIds: deluxeId })
      .set(auth())
      .expect(200);
    const day = (grid.body.roomTypes[0].days as { date: string; available: number }[]).find(
      (entry) => entry.date === date,
    );
    return day!.available;
  }

  async function folioRows(id: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM folio_payments WHERE reservation_id = $1',
      [id],
    );
    return rows[0]!.n;
  }

  async function eventCounts(): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ event_type: string; n: number }>(
      `SELECT event_type, count(*)::int AS n FROM outbox_events
        WHERE organization_id = $1 GROUP BY event_type`,
      [orgId],
    );
    return Object.fromEntries(rows.map((row) => [row.event_type, row.n]));
  }

  async function status(id: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [id],
    );
    return rows[0]!.status;
  }

  it('closes the booking, keeps yesterday, and puts tonight back on sale', async () => {
    const id = await book(0); // yesterday + tonight
    expect(await availableOn(dates[1]!)).toBe(0);
    const before = await folioRows(id);
    const inventoryEventsBefore = (await eventCounts())['inventory.changed'] ?? 0;

    const response = await noShow(id, 200, { reason: 'Did not arrive' });
    expect(response.body).toEqual({
      id,
      status: 'NO_SHOW',
      releasedNights: [dates[1]],
      retainedNights: [dates[0]],
    });

    expect(await status(id)).toBe('NO_SHOW');
    expect(await booked(dates[0]!)).toBe(1);
    expect(await booked(dates[1]!)).toBe(0);
    expect(await availableOn(dates[1]!)).toBe(1);
    expect(await folioRows(id)).toBe(before);

    const audit = await pool.query<{ after_state: Record<string, unknown>; reason: string }>(
      `SELECT "after" AS after_state, reason FROM audit_logs
        WHERE organization_id = $1 AND action = 'reservation.no_show' AND entity_id = $2`,
      [orgId, id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.reason).toBe('Did not arrive');
    expect(audit.rows[0]!.after_state).toMatchObject({
      status: 'NO_SHOW',
      releasedNights: [dates[1]],
      retainedNights: [dates[0]],
      roomsReleased: 0,
    });

    const events = await eventCounts();
    expect(events['reservation.no_show']).toBe(1);
    // The booking posted one; the release posts another.
    expect(events['inventory.changed']).toBe(inventoryEventsBefore + 1);
  });

  it('refuses before the day after check-in and changes nothing', async () => {
    const tomorrowId = await book(2); // arrives in two days
    const tomorrow = await noShow(tomorrowId, 422);
    expect(tomorrow.body.error.code).toBe('NO_SHOW_TOO_EARLY');
    expect(tomorrow.body.error.details).toMatchObject({ checkIn: dates[2] });
    expect(await status(tomorrowId)).toBe('CONFIRMED');
    expect(await booked(dates[2]!)).toBe(1);
    expect(await folioRows(tomorrowId)).toBe(0);
  });

  it('refuses on the arrival day itself: a late flight still needs its room', async () => {
    const id = await book(1); // check-in today
    const response = await noShow(id, 422);
    expect(response.body.error.code).toBe('NO_SHOW_TOO_EARLY');
    expect(response.body.error.details).toMatchObject({ checkIn: dates[1], today: dates[1] });
    expect(await status(id)).toBe('CONFIRMED');
    expect(await booked(dates[1]!)).toBe(1);
  });

  it('refuses a PENDING booking: holds expire, they are not no-shows', async () => {
    const id = await book(0, 'PENDING');
    const response = await noShow(id, 409);
    expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await status(id)).toBe('PENDING');
  });

  it('refuses a stale version', async () => {
    const id = await book(0);
    const response = await request(app.getHttpServer())
      .post(`${base(id)}/no-show`)
      .set(auth())
      .send({ version: (await version(id)) + 5 })
      .expect(409);
    expect(response.body.error.code).toBe('VERSION_MISMATCH');
    expect(await status(id)).toBe('CONFIRMED');
    expect(await booked(dates[1]!)).toBe(1);
  });

  it('refuses a second call', async () => {
    const id = await book(0);
    await noShow(id, 200);
    const again = await noShow(id, 409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await booked(dates[1]!)).toBe(0);
  });

  it('needs reservation:update', async () => {
    const id = await book(0);
    await noShow(id, 403, {}, { Authorization: `Bearer ${readerToken}` });
    expect(await status(id)).toBe('CONFIRMED');
  });

  it("does not reach another property's booking", async () => {
    const id = await book(0);
    const response = await request(app.getHttpServer())
      .post(`${base(id, otherPropertyId)}/no-show`)
      .set(auth())
      .send({ version: await version(id) })
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await status(id)).toBe('CONFIRMED');
  });

  it('rejects unknown body fields and an over-long reason', async () => {
    const id = await book(0);
    await noShow(id, 422, { surprise: true });
    await noShow(id, 422, { reason: 'x'.repeat(501) });
  });

  it('a stay wholly in the past has nothing to release and posts no inventory event', async () => {
    const id = await book(0, 'CONFIRMED', 1); // last night only
    const before = (await eventCounts())['inventory.changed'] ?? 0;
    const response = await noShow(id, 200);
    expect(response.body).toMatchObject({ releasedNights: [], retainedNights: [dates[0]] });
    expect(await booked(dates[0]!)).toBe(1);
    expect((await eventCounts())['inventory.changed'] ?? 0).toBe(before);
  });

  it('unassigns the room and refuses to give a no-show a room afterwards', async () => {
    const { id, stayId } = await bookWithStay(0);
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(200);

    await noShow(id, 200);

    const stay = await pool.query<{ assigned_room_id: string | null }>(
      'SELECT assigned_room_id FROM reservation_stays WHERE id = $1',
      [stayId],
    );
    expect(stay.rows[0]!.assigned_room_id).toBeNull();
    const audit = await pool.query<{ after_state: { roomsReleased: number } }>(
      `SELECT "after" AS after_state FROM audit_logs
        WHERE organization_id = $1 AND action = 'reservation.no_show' AND entity_id = $2`,
      [orgId, id],
    );
    expect(audit.rows[0]!.after_state.roomsReleased).toBe(1);

    const again = await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it("does not reach another organization's booking", async () => {
    const id = await book(0);
    await request(app.getHttpServer())
      .post(`${base(id)}/no-show`)
      .set({ Authorization: `Bearer ${otherOrgToken}` })
      .send({ version: await version(id) })
      .expect(404);
    expect(await status(id)).toBe('CONFIRMED');
  });

  describe('inventory reconciliation', () => {
    async function driftForProperty() {
      const { ReconcileInventoryUseCase } =
        await import('../inventory/application/reconcile-inventory.usecase');
      const result = await app.get(ReconcileInventoryUseCase, { strict: false }).execute();
      return result.drift.filter((row) => row.propertyId === propertyId);
    }

    it('sees no drift after a no-show of a stay that began yesterday', async () => {
      const id = await book(0);
      await noShow(id, 200);
      expect(await driftForProperty()).toEqual([]);
    });

    it('sees no drift after cancelling a stay already in the house', async () => {
      const { id, stayId } = await bookWithStay(0);
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${base(id)}/check-in`)
        .set(auth())
        .send({ version: await version(id) })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${base(id)}/cancel`)
        .set(auth())
        .send({ version: await version(id) })
        .expect(200);
      expect(await booked(dates[0]!)).toBe(1); // yesterday retained
      expect(await booked(dates[1]!)).toBe(0);
      expect(await driftForProperty()).toEqual([]);
    });

    it('sees no drift after a lapsed hold is expired', async () => {
      const id = await book(1, 'PENDING');
      await pool.query(
        `UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      );
      const { ExpireHoldsUseCase } = await import('../inventory/application/expire-holds.usecase');
      await app.get(ExpireHoldsUseCase, { strict: false }).execute();
      expect(await status(id)).toBe('EXPIRED');
      expect(await driftForProperty()).toEqual([]);
    });
  });
});
