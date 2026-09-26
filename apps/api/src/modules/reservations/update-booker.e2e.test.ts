/**
 * Correcting who booked, against real PostgreSQL.
 *
 * The record a desk types at 05:49 is rarely the one the guest would sign.
 * These prove the correction is exactly a contact change: guarded by version,
 * audited before/after, visible on the stay view, and unable to reach money,
 * status or dates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Booker e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

const NIGHTS = ['2031-07-01', '2031-07-02', '2031-07-03'] as const;

describeIfDb('Correcting the booker', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'booker-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `bk-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
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
         VALUES ($1, $2, $3, 'Booker Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
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
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR-DLX', 'Best Available')`,
      [deluxePlanId, orgId, propertyId, deluxeId],
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
    for (const date of NIGHTS) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 2)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 120000, 'THB')`,
          [orgId, propertyId, deluxePlanId, date, occupancy],
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

  async function book() {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'WALK_IN',
        booker: { name: 'เสี่ยวหยู/Wechat' },
        stays: [
          {
            roomTypeId: deluxeId,
            ratePlanId: deluxePlanId,
            checkIn: NIGHTS[0],
            checkOut: NIGHTS[2],
            adults: 1,
            roomId,
          },
        ],
      })
      .expect(201);
    // The create response carries no version; the detail read does.
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${response.body.id as string}`)
      .set(auth())
      .expect(200);
    return {
      reservationId: response.body.id as string,
      version: detail.body.version as number,
      total: detail.body.total as unknown,
    };
  }

  function patch(reservationId: string, body: Record<string, unknown>, bearer = token) {
    return request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set({ Authorization: `Bearer ${bearer}` })
      .send(body);
  }

  it('corrects name, email and phone, bumps the version, and leaves money alone', async () => {
    const { reservationId, version, total } = await book();

    const response = await patch(reservationId, {
      version,
      bookerName: 'Xiao Yu',
      bookerEmail: 'xiaoyu@example.com',
      bookerPhone: '+66 81 234 5678',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(response.body).toMatchObject({
      id: reservationId,
      version: version + 1,
      bookerName: 'Xiao Yu',
      bookerEmail: 'xiaoyu@example.com',
      bookerPhone: '+66 81 234 5678',
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.bookerName).toBe('Xiao Yu');
    expect(detail.body.bookerPhone).toBe('+66 81 234 5678');
    expect(detail.body.version).toBe(version + 1);
    expect(detail.body.total).toEqual(total);
    expect(detail.body.status).toBe('CONFIRMED');
  });

  it('shows the corrected name on the stay view, where the desk reads it', async () => {
    const { reservationId, version } = await book();
    await patch(reservationId, { version, bookerName: 'Xiao Yu' }).expect(200);

    const view = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/stay-view?from=${NIGHTS[0]}&to=${NIGHTS[2]}`)
      .set(auth())
      .expect(200);
    const room = view.body.rooms.find((row: { roomNumber: string }) => row.roomNumber === '401');
    expect(room.stays).toHaveLength(1);
    expect(room.stays[0].guestName).toBe('Xiao Yu');
  });

  it('clears an optional field with null, and treats an empty string the same way', async () => {
    const { reservationId, version } = await book();
    await patch(reservationId, {
      version,
      bookerEmail: 'x@example.com',
      bookerPhone: '0812345678',
    }).expect(200);

    const cleared = await patch(reservationId, {
      version: version + 1,
      bookerEmail: null,
      bookerPhone: '',
    }).expect(200);
    expect(cleared.body.bookerEmail).toBeNull();
    expect(cleared.body.bookerPhone).toBeNull();
  });

  it('refuses a stale version rather than overwriting a colleague', async () => {
    const { reservationId, version } = await book();
    await patch(reservationId, { version, bookerName: 'First desk' }).expect(200);

    const response = await patch(reservationId, { version, bookerName: 'Second desk' }).expect(409);
    expect(response.body.error.code).toBe('VERSION_MISMATCH');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.bookerName).toBe('First desk');
  });

  it('refuses an empty correction, and anything that is not contact text', async () => {
    const { reservationId, version } = await book();
    await patch(reservationId, { version }).expect(422);
    await patch(reservationId, { version, status: 'CANCELLED' }).expect(422);
    await patch(reservationId, { version, bookerName: '' }).expect(422);
  });

  it('answers 404 through another property, and 403 without the capability', async () => {
    const { reservationId, version } = await book();

    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${otherPropertyId}/reservations/${reservationId}`)
      .set(auth())
      .send({ version, bookerName: 'Nope' })
      .expect(404);

    await patch(reservationId, { version, bookerName: 'Nope' }, readerToken).expect(403);
  });

  it('leaves the guest profile alone unless asked, then corrects it too', async () => {
    const { reservationId, version } = await book();
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);
    const guestId = detail.body.guestId as string;
    expect(guestId).toBeTruthy();

    // Without the flag the profile keeps what the booking was made with.
    await patch(reservationId, { version, bookerName: 'Xiao Yu Wang' }).expect(200);
    let guest = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests/${guestId}`)
      .set(auth())
      .expect(200);
    expect(guest.body.firstName).toBe('เสี่ยวหยู/Wechat');

    const response = await patch(reservationId, {
      version: version + 1,
      bookerName: 'Xiao Yu Wang',
      bookerPhone: '+66 81 234 5678',
      applyToGuest: true,
    }).expect(200);
    expect(response.body.guestUpdated).toBe(true);

    guest = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests/${guestId}`)
      .set(auth())
      .expect(200);
    expect(guest.body).toMatchObject({
      firstName: 'Xiao Yu',
      lastName: 'Wang',
      phone: '+66 81 234 5678',
    });

    const { rows } = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_id = $2`,
      [orgId, guestId],
    );
    expect(rows.map((row) => row.action)).toContain('guest.updated');
  });

  it('writes an audit entry with the contact before and after', async () => {
    const { reservationId, version } = await book();
    await patch(reservationId, {
      version,
      bookerName: 'Xiao Yu',
      bookerPhone: '0812345678',
    }).expect(200);

    const { rows } = await pool.query<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(
      `SELECT before, after FROM audit_logs
       WHERE organization_id = $1 AND action = 'reservation.booker_updated' AND entity_id = $2`,
      [orgId, reservationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toMatchObject({ bookerName: 'เสี่ยวหยู/Wechat', bookerPhone: null });
    expect(rows[0]!.after).toMatchObject({ bookerName: 'Xiao Yu', bookerPhone: '0812345678' });
  });
});
