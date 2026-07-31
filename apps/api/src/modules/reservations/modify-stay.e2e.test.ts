/**
 * Modifying a booking, against real PostgreSQL.
 *
 * The dangerous part is not the update — it is the inventory handoff. These
 * check that the old nights come back, the new ones are taken, an unsellable
 * change leaves the ORIGINAL booking intact, and that a stay shifted onto dates
 * overlapping itself does not compete with its own held nights.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Modify e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/** Far future, so the property's business date never makes these stays "begun". */
const NIGHTS = ['2030-04-01', '2030-04-02', '2030-04-03', '2030-04-04', '2030-04-05'] as const;
const RATE_MINOR = 100000;

describeIfDb('Modifying a stay', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'modify-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `mo-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const suiteId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const suitePlanId = crypto.randomUUID();
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
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
       VALUES ($1, $2, 'MAIN', 'Modify Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
      [propertyId, orgId],
    );

    for (const [roomType, code, name] of [
      [deluxeId, 'DLX', 'Deluxe'],
      [suiteId, 'STE', 'Suite'],
    ] as const) {
      await pool.query(
        `INSERT INTO room_types (id, organization_id, property_id, code, name,
                                 standard_occupancy, max_occupancy, max_adults, max_children)
         VALUES ($1, $2, $3, $4, $5, 2, 4, 3, 2)`,
        [roomType, orgId, propertyId, code, name],
      );
    }
    for (const [plan, roomType, code] of [
      [deluxePlanId, deluxeId, 'BAR-DLX'],
      [suitePlanId, suiteId, 'BAR-STE'],
    ] as const) {
      await pool.query(
        `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
         VALUES ($1, $2, $3, $4, $5, 'Best Available')`,
        [plan, orgId, propertyId, roomType, code],
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
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'rate_days',
      'inventory_days',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    // Both room types sellable across the whole window, at one price.
    for (const roomTypeId of [deluxeId, suiteId]) {
      for (const date of NIGHTS) {
        await pool.query(
          `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
           VALUES ($1, $2, $3, $4, 2)`,
          [orgId, propertyId, roomTypeId, date],
        );
      }
    }
    for (const ratePlanId of [deluxePlanId, suitePlanId]) {
      for (const date of NIGHTS) {
        for (const occupancy of [1, 2, 3]) {
          await pool.query(
            `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                    occupancy, amount_minor, currency)
             VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
            [orgId, propertyId, ratePlanId, date, occupancy, RATE_MINOR],
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

  async function book(
    checkIn: string,
    checkOut: string,
    roomTypeId = deluxeId,
    ratePlanId = deluxePlanId,
  ) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'PHONE',
        booker: { name: 'Somchai Prasert' },
        stays: [{ roomTypeId, ratePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return {
      reservationId: response.body.id as string,
      stayId: response.body.stays[0].id as string,
    };
  }

  function patch(reservationId: string, stayId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}`)
      .set(auth())
      .send(body);
  }

  async function bookedOn(roomTypeId: string, date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [roomTypeId, date],
    );
    return rows[0]?.booked ?? -1;
  }

  it('releases the old nights and holds the new ones', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-03');
    expect(await bookedOn(deluxeId, '2030-04-01')).toBe(1);

    const response = await patch(reservationId, stayId, {
      version: 0,
      checkIn: '2030-04-04',
      checkOut: '2030-04-05',
    }).expect(200);

    expect(response.body.releasedNights).toEqual(['2030-04-01', '2030-04-02']);
    expect(response.body.heldNights).toEqual(['2030-04-04']);
    expect(await bookedOn(deluxeId, '2030-04-01')).toBe(0);
    expect(await bookedOn(deluxeId, '2030-04-02')).toBe(0);
    expect(await bookedOn(deluxeId, '2030-04-04')).toBe(1);
  });

  /**
   * The reason the release happens BEFORE the hold.
   *
   * With one unit left, shifting 1st–3rd to 2nd–4th overlaps the booking's own
   * night on the 2nd. Holding first would find it sold out — by itself.
   */
  it('lets a stay shift onto dates that overlap its own nights', async () => {
    // Squeeze the room type down to a single sellable unit, and take it.
    await pool.query(
      `UPDATE inventory_days SET allotment = 1 WHERE room_type_id = $1 AND organization_id = $2`,
      [deluxeId, orgId],
    );
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-03');

    await patch(reservationId, stayId, {
      version: 0,
      checkIn: '2030-04-02',
      checkOut: '2030-04-04',
    }).expect(200);

    expect(await bookedOn(deluxeId, '2030-04-01')).toBe(0);
    expect(await bookedOn(deluxeId, '2030-04-02')).toBe(1);
    expect(await bookedOn(deluxeId, '2030-04-03')).toBe(1);
  });

  it('moves the hold to the new room type when the type changes', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-03');

    await patch(reservationId, stayId, {
      version: 0,
      roomTypeId: suiteId,
      ratePlanId: suitePlanId,
    }).expect(200);

    expect(await bookedOn(deluxeId, '2030-04-01')).toBe(0);
    expect(await bookedOn(suiteId, '2030-04-01')).toBe(1);
    expect(await bookedOn(suiteId, '2030-04-02')).toBe(1);
  });

  /**
   * The whole thing is one transaction. A refused change must leave the
   * ORIGINAL booking holding its original nights — not nothing.
   */
  it('leaves the booking untouched when the new dates are sold out', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    // Fill the 4th completely with other bookings.
    await pool.query(
      `UPDATE inventory_days SET booked = allotment WHERE room_type_id = $1 AND date = '2030-04-04'`,
      [deluxeId],
    );

    await patch(reservationId, stayId, {
      version: 0,
      checkIn: '2030-04-04',
      checkOut: '2030-04-05',
    }).expect(409);

    expect(await bookedOn(deluxeId, '2030-04-01')).toBe(1);
    const { rows } = await pool.query<{ check_in: string; version: number }>(
      `SELECT s.check_in, r.version FROM reservation_stays s
         JOIN reservations r ON r.id = s.reservation_id WHERE s.id = $1`,
      [stayId],
    );
    expect(rows[0]?.version).toBe(0);
  });

  it('re-prices the booking from the new nights', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');

    // One night to three: the total must triple, not stay put.
    await patch(reservationId, stayId, { version: 0, checkOut: '2030-04-04' }).expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);

    expect(detail.body.subtotal.amount).toBe(RATE_MINOR * 3);
    expect(detail.body.stays[0].nights).toHaveLength(3);
    expect(detail.body.version).toBe(1);
  });

  it('refuses a stale version rather than overwriting', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await patch(reservationId, stayId, { version: 0, adults: 3 }).expect(200);

    // Version is now 1; a second tab still holding 0 must be refused.
    await patch(reservationId, stayId, { version: 0, adults: 1 }).expect(409);
  });

  /**
   * A room belongs to one room type and to the nights it was assigned for.
   * Both change here, so the assignment cannot survive.
   */
  it('clears the room assignment when the dates move', async () => {
    const roomId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
       VALUES ($1, $2, $3, $4, '301')`,
      [roomId, orgId, propertyId, deluxeId],
    );
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(200);

    const response = await patch(reservationId, stayId, {
      version: 0,
      checkIn: '2030-04-03',
      checkOut: '2030-04-04',
    }).expect(200);

    expect(response.body.roomAssignmentCleared).toBe(true);
    const { rows } = await pool.query<{ assigned_room_id: string | null }>(
      'SELECT assigned_room_id FROM reservation_stays WHERE id = $1',
      [stayId],
    );
    expect(rows[0]?.assigned_room_id).toBeNull();
  });

  /** Occupancy alone does not move the guest, so the room stays theirs. */
  it('keeps the room assignment when only occupancy changes', async () => {
    const roomId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
       VALUES ($1, $2, $3, $4, '302')`,
      [roomId, orgId, propertyId, deluxeId],
    );
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(200);

    const response = await patch(reservationId, stayId, { version: 0, adults: 3 }).expect(200);
    expect(response.body.roomAssignmentCleared).toBe(false);
  });

  /**
   * Rate plans belong to exactly one room type. Keeping the old plan would
   * price a suite off the standard-room plan.
   */
  it('refuses a room type change with no rate plan for the new type', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await patch(reservationId, stayId, { version: 0, roomTypeId: suiteId }).expect(422);
  });

  it('refuses to modify a cancelled booking', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    await patch(reservationId, stayId, { version: 1, adults: 3 }).expect(409);
  });

  /** A stay id from another booking must not be reachable through this URL. */
  it('refuses a stay that belongs to a different reservation', async () => {
    const first = await book('2030-04-01', '2030-04-02');
    const second = await book('2030-04-03', '2030-04-04');

    await patch(first.reservationId, second.stayId, { version: 0, adults: 3 }).expect(404);
  });

  it('records the change in the audit trail with before and after', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await patch(reservationId, stayId, {
      version: 0,
      checkOut: '2030-04-03',
      reason: 'Guest asked to stay another night',
    }).expect(200);

    const { rows } = await pool.query<{
      action: string;
      before: { checkOut: string };
      after: { checkOut: string };
      reason: string | null;
    }>(
      `SELECT action, before, after, reason FROM audit_logs
        WHERE entity_id = $1 AND action = 'reservation.modified'`,
      [reservationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before.checkOut).toBe('2030-04-02');
    expect(rows[0]?.after.checkOut).toBe('2030-04-03');
    expect(rows[0]?.reason).toBe('Guest asked to stay another night');
  });

  /**
   * The endpoint is guarded by `reservation:modify`, which FRONT_DESK and above
   * hold. Guarding it with `reservation:update` instead would have left
   * `reservation:modify` a capability nothing in the codebase ever checks.
   */
  it('refuses a reader who lacks reservation:modify', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');

    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}`)
      .set({ Authorization: `Bearer ${readerToken}` })
      .send({ version: 0, adults: 3 })
      .expect(403);
  });

  it('rejects a change that alters nothing', async () => {
    const { reservationId, stayId } = await book('2030-04-01', '2030-04-02');
    await patch(reservationId, stayId, { version: 0, adults: 2 }).expect(422);
  });
});
