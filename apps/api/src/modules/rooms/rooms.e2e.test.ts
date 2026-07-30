/**
 * Physical rooms, assignment and the stay view, against real PostgreSQL.
 *
 * The centrepiece is that two bookings cannot hold the same room on
 * overlapping nights — enforced by an exclusion constraint, so it holds under
 * concurrency rather than only when the application remembers to check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Room e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Rooms and stay view', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'rooms-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `rm-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const standardId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `rmx-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();

  let managerToken = '';

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

    for (const [org, slug, property] of [
      [orgId, orgSlug, propertyId],
      [otherOrgId, otherOrgSlug, otherPropertyId],
    ] as const) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
        org,
        slug,
      ]);
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, 'MAIN', $3, 'Asia/Bangkok', 'THB', 'TH')`,
        [property, org, `Hotel ${slug}`],
      );
    }

    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe'), ($4, $2, $3, 'STD', 'Standard')`,
      [deluxeId, orgId, propertyId, standardId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
      [ratePlanId, orgId, propertyId, deluxeId],
    );

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

    managerToken = await tokenFor(`manager-${orgSlug}@e2e.test`);
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

  async function tokenFor(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  const auth = () => ({ Authorization: `Bearer ${managerToken}` });

  beforeEach(async () => {
    await pool.query('DELETE FROM reservation_stay_nights WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservation_stays WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM physical_rooms WHERE organization_id = $1', [orgId]);
  });

  async function createRoom(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rooms`)
      .set(auth())
      .send({
        roomTypeId: deluxeId,
        roomNumber: `R${Math.floor(Math.random() * 1e6)}`,
        ...overrides,
      })
      .expect(201);
    return response.body.id as string;
  }

  /** A stay written directly: booking flow is covered elsewhere. */
  async function createStay(checkIn: string, checkOut: string, roomTypeId = deluxeId) {
    const reservationId = crypto.randomUUID();
    const stayId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO reservations (id, organization_id, property_id, code, status, source,
                                 booker_name, currency)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', 'WALK_IN', 'Somchai', 'THB')`,
      [reservationId, orgId, propertyId, `RM-${stayId.slice(0, 6).toUpperCase()}`],
    );
    await pool.query(
      `INSERT INTO reservation_stays
         (id, organization_id, property_id, reservation_id, room_type_id, rate_plan_id,
          check_in, check_out, adults, guest_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2, 'Somchai Prasert')`,
      [stayId, orgId, propertyId, reservationId, roomTypeId, ratePlanId, checkIn, checkOut],
    );
    return { reservationId, stayId };
  }

  describe('managing rooms', () => {
    it('creates a room and lists it', async () => {
      await createRoom({ roomNumber: '101', floor: '1' });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/rooms`)
        .set(auth())
        .expect(200);

      expect(response.body.items[0]).toMatchObject({
        roomNumber: '101',
        floor: '1',
        housekeepingStatus: 'CLEAN',
        isActive: true,
      });
    });

    it('rejects a duplicate room number as a conflict', async () => {
      await createRoom({ roomNumber: '202' });
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rooms`)
        .set(auth())
        .send({ roomTypeId: deluxeId, roomNumber: '202' })
        .expect(409);
    });

    // "10" must come after "9", not after "1" — room numbers are text because
    // "12A" and "P1" are real, but people read them as numbers.
    it('orders rooms the way a corridor runs', async () => {
      for (const roomNumber of ['9', '10', '2']) {
        await createRoom({ roomNumber, floor: '1' });
      }
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/rooms`)
        .set(auth())
        .expect(200);

      expect((response.body.items as { roomNumber: string }[]).map((r) => r.roomNumber)).toEqual([
        '2',
        '9',
        '10',
      ]);
    });

    it('changes housekeeping status', async () => {
      const roomId = await createRoom();
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rooms/${roomId}`)
        .set(auth())
        .send({ housekeepingStatus: 'DIRTY' })
        .expect(200);

      expect(response.body.housekeepingStatus).toBe('DIRTY');

      const { rows } = await pool.query<{ action: string }>(
        'SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1',
        [roomId],
      );
      expect(rows[0]?.action).toBe('room.housekeeping_changed');
    });

    it('refuses a housekeeping status the database would reject', async () => {
      const roomId = await createRoom();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rooms/${roomId}`)
        .set(auth())
        .send({ housekeepingStatus: 'SPARKLING' })
        .expect(422);
    });

    it('will not move a room to another room type', async () => {
      const roomId = await createRoom();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rooms/${roomId}`)
        .set(auth())
        .send({ roomTypeId: standardId })
        .expect(422);
    });

    it('forbids a READ_ONLY user from creating rooms', async () => {
      const token = await tokenFor(`reader-${orgSlug}@e2e.test`);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rooms`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roomTypeId: deluxeId, roomNumber: '999' })
        .expect(403);
      expect(response.body.error.details.capability).toBe('room:create');
    });

    it('will not attach a room to another organization room type', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/rooms`)
        .set(auth())
        .send({ roomTypeId: deluxeId, roomNumber: '1' })
        .expect(404);
    });
  });

  describe('assigning a room', () => {
    it('assigns and releases', async () => {
      const roomId = await createRoom();
      const { stayId } = await createStay('2027-05-01', '2027-05-04');

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId: null })
        .expect(200);

      const { rows } = await pool.query<{ assigned_room_id: string | null }>(
        'SELECT assigned_room_id FROM reservation_stays WHERE id = $1',
        [stayId],
      );
      expect(rows[0]?.assigned_room_id).toBeNull();
    });

    /**
     * The guarantee. Enforced by an exclusion constraint rather than a read
     * followed by a write, so it holds when two people assign at once — the
     * front desk finds out at check-in, with the guest standing there.
     */
    it('refuses to put two bookings in one room on overlapping nights', async () => {
      const roomId = await createRoom({ roomNumber: '301' });
      const first = await createStay('2027-05-01', '2027-05-05');
      const second = await createStay('2027-05-04', '2027-05-08');

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${first.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${second.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
      // The message names the dates, so the front desk can act on it.
      expect(response.body.error.message).toContain('301');
    });

    // Hotel nights are half-open: one guest leaves in the morning, the next
    // arrives in the afternoon. That is not a conflict.
    it('allows a departure and an arrival on the same day', async () => {
      const roomId = await createRoom();
      const first = await createStay('2027-05-01', '2027-05-04');
      const second = await createStay('2027-05-04', '2027-05-06');

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${first.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${second.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);
    });

    it('refuses a room that is out of order', async () => {
      const roomId = await createRoom();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rooms/${roomId}`)
        .set(auth())
        .send({ housekeepingStatus: 'OUT_OF_ORDER' })
        .expect(200);

      const { stayId } = await createStay('2027-06-01', '2027-06-03');
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(422);

      expect(response.body.error.message).toMatch(/out of order/i);
    });

    // Upgrades are a normal front-desk decision, so this is allowed — and
    // recorded, because it is worth being able to ask later.
    it('allows an upgrade into a different room type and records it', async () => {
      const roomId = await createRoom({ roomTypeId: standardId });
      const { stayId } = await createStay('2027-07-01', '2027-07-03', deluxeId);

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      const { rows } = await pool.query<{ after: { upgraded?: boolean } }>(
        "SELECT after FROM audit_logs WHERE action = 'stay.room_assigned' AND entity_id = $1",
        [stayId],
      );
      expect(rows[0]?.after.upgraded).toBe(true);
    });

    it('forbids a READ_ONLY user from assigning', async () => {
      const roomId = await createRoom();
      const { stayId } = await createStay('2027-08-01', '2027-08-02');
      const token = await tokenFor(`reader-${orgSlug}@e2e.test`);

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roomId })
        .expect(403);
    });

    /**
     * Without this the room would stay blocked for those nights forever: the
     * exclusion constraint cannot see reservation status.
     */
    it('frees the room when the reservation is cancelled', async () => {
      const roomId = await createRoom();
      const first = await createStay('2027-09-01', '2027-09-05');

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${first.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${first.reservationId}/cancel`)
        .set(auth())
        .send({ version: 0 })
        .expect(200);

      const { rows } = await pool.query<{ assigned_room_id: string | null }>(
        'SELECT assigned_room_id FROM reservation_stays WHERE id = $1',
        [first.stayId],
      );
      expect(rows[0]?.assigned_room_id).toBeNull();

      // And the room is genuinely reusable for the same nights.
      const second = await createStay('2027-09-01', '2027-09-05');
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${second.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);
    });
  });

  describe('check-in and check-out', () => {
    /** Today in the property timezone, so "arrives today" is deterministic. */
    function today(): string {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    }

    function daysFromToday(days: number): string {
      const base = new Date(`${today()}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + days);
      return base.toISOString().slice(0, 10);
    }

    it('checks in a booking whose rooms are all assigned', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(2));

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: 0 })
        .expect(200);

      expect(response.body.status).toBe('CHECKED_IN');
      expect(response.body.checkedInAt).toBeTypeOf('string');
    });

    /**
     * Otherwise a guest is checked in with nowhere to sleep, and the front desk
     * discovers it while handing over a key.
     */
    it('refuses to check in when a room is still unassigned', async () => {
      const { reservationId } = await createStay(today(), daysFromToday(2));

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: 0 })
        .expect(422);

      expect(response.body.error.message).toMatch(/assign a room/i);
    });

    it('refuses to check in a booking that arrives later', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(daysFromToday(7), daysFromToday(9));

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: 0 })
        .expect(422);

      expect(response.body.error.message).toMatch(/arrives on/i);
    });

    // Early arrival on the day is ordinary; a guest turning up at 9am has not
    // done anything unusual.
    it('allows an early arrival on the arrival day', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(1));

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
    });

    it('refuses to check in a cancelled booking', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(2));

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
        .set(auth())
        .send({ version: 0 })
        .expect(200);

      // An illegal transition is a CONFLICT, not a validation failure: the
      // request was well-formed, the reservation is simply not in that state.
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: 1 })
        .expect(409);
    });

    it('refuses a stale version', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(2));
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set(auth())
        .send({ version: 7 })
        .expect(409);
    });

    /**
     * The reason check-out is worth modelling rather than flipping a status: a
     * departed room cannot be given to anyone until it is cleaned.
     */
    it('checks out and hands the rooms to housekeeping', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(2));

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

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
        .set(auth())
        .send({ version: 1 })
        .expect(200);

      expect(response.body.status).toBe('CHECKED_OUT');

      const { rows } = await pool.query<{ housekeeping_status: string }>(
        'SELECT housekeeping_status FROM physical_rooms WHERE id = $1',
        [roomId],
      );
      expect(rows[0]?.housekeeping_status).toBe('DIRTY');
    });

    // Housekeeping owns that state; a departure does not quietly put a broken
    // room back into circulation.
    it('leaves an out-of-order room out of order', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(2));

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
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rooms/${roomId}`)
        .set(auth())
        .send({ housekeepingStatus: 'OUT_OF_ORDER' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
        .set(auth())
        .send({ version: 1 })
        .expect(200);

      const { rows } = await pool.query<{ housekeeping_status: string }>(
        'SELECT housekeeping_status FROM physical_rooms WHERE id = $1',
        [roomId],
      );
      expect(rows[0]?.housekeeping_status).toBe('OUT_OF_ORDER');
    });

    it('refuses to check out a booking that never checked in', async () => {
      const { reservationId } = await createStay(today(), daysFromToday(2));
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
        .set(auth())
        .send({ version: 0 })
        .expect(409);
    });

    /**
     * The guest occupied those nights. Releasing them would make historical
     * occupancy lie and let a past date be resold.
     */
    it('keeps the room assignment and the nights after check-out', async () => {
      const roomId = await createRoom();
      const { reservationId, stayId } = await createStay(today(), daysFromToday(2));

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
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
        .set(auth())
        .send({ version: 1 })
        .expect(200);

      const { rows } = await pool.query<{ assigned_room_id: string | null }>(
        'SELECT assigned_room_id FROM reservation_stays WHERE id = $1',
        [stayId],
      );
      // "Who was in 302 last Tuesday" is a question hotels genuinely ask.
      expect(rows[0]?.assigned_room_id).toBe(roomId);
    });

    it('forbids a READ_ONLY user from checking in', async () => {
      const { reservationId } = await createStay(today(), daysFromToday(2));
      const token = await tokenFor(`reader-${orgSlug}@e2e.test`);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({ version: 0 })
        .expect(403);

      expect(response.body.error.details.capability).toBe('reservation:checkin');
    });
  });

  describe('stay view', () => {
    it('shows who is in which room, and what still needs one', async () => {
      const roomId = await createRoom({ roomNumber: '401' });
      const assigned = await createStay('2027-10-02', '2027-10-05');
      await createStay('2027-10-03', '2027-10-04');

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/stays/${assigned.stayId}/room`)
        .set(auth())
        .send({ roomId })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/stay-view?from=2027-10-01&to=2027-10-08`)
        .set(auth())
        .expect(200);

      const room = response.body.rooms.find((r: { roomNumber: string }) => r.roomNumber === '401');
      expect(room.stays).toHaveLength(1);
      expect(room.stays[0].guestName).toBe('Somchai Prasert');
      // The front desk's actual worklist.
      expect(response.body.unassigned).toHaveLength(1);
    });

    it('leaves cancelled bookings out — they are not arriving', async () => {
      const { reservationId } = await createStay('2027-11-01', '2027-11-03');

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
        .set(auth())
        .send({ version: 0 })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/stay-view?from=2027-11-01&to=2027-11-05`)
        .set(auth())
        .expect(200);

      expect(response.body.unassigned).toHaveLength(0);
    });

    it('excludes a stay that departs before the window opens', async () => {
      await createStay('2027-12-01', '2027-12-05');
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/stay-view?from=2027-12-05&to=2027-12-10`)
        .set(auth())
        .expect(200);

      expect(response.body.unassigned).toHaveLength(0);
    });

    it('rejects an inverted or oversized range', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/stay-view?from=2027-12-10&to=2027-12-01`)
        .set(auth())
        .expect(422);

      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/stay-view?from=2027-01-01&to=2027-12-01`)
        .set(auth())
        .expect(422);
    });
  });
});
