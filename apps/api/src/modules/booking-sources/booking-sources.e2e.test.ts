/**
 * Booking sources over HTTP, against real PostgreSQL: the list a property
 * keeps of where its bookings come from, and the rule that a booking keyed
 * in by hand as OTA or TRAVEL_AGENT must say which one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Booking source tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Booking sources', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'booking-sources-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `bs-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const frontDeskId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `bsx-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();

  const HORIZON = ['2029-03-01', '2029-03-02', '2029-03-03', '2029-03-04'];

  let ownerToken = '';
  let frontDeskToken = '';

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
       VALUES ($1, $2, $3, 'DLX', 'Deluxe')`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );
    for (const date of HORIZON) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 5, 0)`,
        [orgId, propertyId, roomTypeId, date],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 150000, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy],
        );
      }
    }

    for (const [id, email, role] of [
      [ownerId, `owner-${orgSlug}@e2e.test`, 'OWNER'],
      [frontDeskId, `desk-${orgSlug}@e2e.test`, 'FRONT_DESK'],
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

    ownerToken = await tokenFor(`owner-${orgSlug}@e2e.test`);
    frontDeskToken = await tokenFor(`desk-${orgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const org of [orgId, otherOrgId]) {
      for (const table of [
        'outbox_events',
        'audit_logs',
        'reservation_stay_nights',
        'reservation_stays',
        'reservations',
        'guests',
        'booking_sources',
        'inventory_days',
        'rate_days',
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

  const asOwner = () => ({ Authorization: `Bearer ${ownerToken}` });
  const asDesk = () => ({ Authorization: `Bearer ${frontDeskToken}` });

  beforeEach(async () => {
    await pool.query('DELETE FROM reservation_stay_nights WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservation_stays WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM booking_sources WHERE organization_id = $1', [orgId]);
    await pool.query(`UPDATE inventory_days SET booked = 0 WHERE organization_id = $1`, [orgId]);
  });

  async function addSource(name: string, kind = 'OTA'): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/booking-sources`)
      .set(asOwner())
      .send({ name, kind })
      .expect(201);
    return response.body.id as string;
  }

  function booking(source: string, extra: Record<string, unknown> = {}) {
    return {
      source,
      booker: { name: 'Somchai Prasert' },
      stays: [{ roomTypeId, ratePlanId, checkIn: '2029-03-01', checkOut: '2029-03-03', adults: 2 }],
      ...extra,
    };
  }

  describe('managing the list', () => {
    it('creates, lists, renames and retires a source', async () => {
      const id = await addSource('Bangkok Tours', 'TRAVEL_AGENT');

      let response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/booking-sources`)
        .set(asDesk())
        .expect(200);
      expect(response.body.items).toEqual([
        { id, name: 'Bangkok Tours', kind: 'TRAVEL_AGENT', channelType: null, isActive: true },
      ]);

      response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/booking-sources/${id}`)
        .set(asOwner())
        .send({ name: 'Bangkok Tours Co.', isActive: false })
        .expect(200);
      expect(response.body).toMatchObject({ name: 'Bangkok Tours Co.', isActive: false });

      const { rows } = await pool.query<{ action: string }>(
        'SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at',
        [id],
      );
      expect(rows.map((row) => row.action)).toEqual([
        'booking_source.created',
        'booking_source.updated',
      ]);
    });

    it('refuses a duplicate name, ignoring case', async () => {
      await addSource('Agoda');
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/booking-sources`)
        .set(asOwner())
        .send({ name: 'agoda', kind: 'OTA' })
        .expect(409);
      expect(response.body.error.message).toContain('agoda');
    });

    it('never changes a kind: bookings recorded their category from it', async () => {
      const id = await addSource('Agoda');
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/booking-sources/${id}`)
        .set(asOwner())
        .send({ kind: 'TRAVEL_AGENT' })
        .expect(422);
    });

    it('adds the usual OTAs once, and leaves a retired one retired', async () => {
      let response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/booking-sources/defaults`)
        .set(asOwner())
        .expect(201);
      const names = (response.body.items as { name: string; channelType: string | null }[]).map(
        (item) => item.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'Agoda',
          'Booking.com',
          'Expedia',
          'Trip.com',
          'Airbnb',
          'Traveloka',
        ]),
      );
      expect(names).toHaveLength(6);

      const agoda = (response.body.items as { id: string; name: string }[]).find(
        (item) => item.name === 'Agoda',
      )!;
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/booking-sources/${agoda.id}`)
        .set(asOwner())
        .send({ isActive: false })
        .expect(200);

      response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/booking-sources/defaults`)
        .set(asOwner())
        .expect(201);
      expect(response.body.items).toHaveLength(6);
      expect(
        (response.body.items as { name: string; isActive: boolean }[]).find(
          (item) => item.name === 'Agoda',
        )?.isActive,
      ).toBe(false);
    });

    it('is setup work: the front desk reads the list but cannot change it', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/booking-sources`)
        .set(asDesk())
        .expect(200);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/booking-sources`)
        .set(asDesk())
        .send({ name: 'Agoda', kind: 'OTA' })
        .expect(403);
      expect(response.body.error.details.capability).toBe('channel:update');
    });

    it('does not know another organization property', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/booking-sources`)
        .set(asOwner())
        .send({ name: 'Agoda', kind: 'OTA' })
        .expect(404);
    });
  });

  describe('naming one on a booking', () => {
    it('records which OTA a hand-keyed booking came through', async () => {
      const agoda = await addSource('Agoda');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('OTA', { bookingSourceId: agoda }))
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations/${created.body.id as string}`)
        .set(asDesk())
        .expect(200);
      expect(detail.body.source).toBe('OTA');
      expect(detail.body.bookingSource).toEqual({ id: agoda, name: 'Agoda', kind: 'OTA' });

      const list = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?source=OTA`)
        .set(asDesk())
        .expect(200);
      expect(list.body.items[0].bookingSource).toEqual({ id: agoda, name: 'Agoda' });
    });

    it('takes a travel-agent booking against an agent', async () => {
      const agent = await addSource('Bangkok Tours', 'TRAVEL_AGENT');
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('TRAVEL_AGENT', { bookingSourceId: agent }))
        .expect(201);
    });

    it('refuses an OTA booking that does not say which OTA', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('OTA'))
        .expect(422);
      expect(response.body.error.message).toMatch(/which OTA/i);
    });

    it('refuses a source of the wrong kind', async () => {
      const agent = await addSource('Bangkok Tours', 'TRAVEL_AGENT');
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('OTA', { bookingSourceId: agent }))
        .expect(422);
      expect(response.body.error.message).toMatch(/travel agent, not an OTA/i);
    });

    it('refuses a source on a walk-in', async () => {
      const agoda = await addSource('Agoda');
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('WALK_IN', { bookingSourceId: agoda }))
        .expect(422);
    });

    it('refuses a retired source', async () => {
      const agoda = await addSource('Agoda');
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/booking-sources/${agoda}`)
        .set(asOwner())
        .send({ isActive: false })
        .expect(200);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('OTA', { bookingSourceId: agoda }))
        .expect(422);
      expect(response.body.error.message).toMatch(/no longer in use/i);
    });

    /**
     * The pilot hotel's case: Booking.com sold tonight, the hotel had closed
     * sales on tonight, and the desk could not record the guest who was
     * about to arrive. An OTA booking is absorbed and flagged, as a
     * connector's would be; a walk-in on the same night is still refused.
     */
    it('takes an OTA booking past a stop-sell and says so; a walk-in is still refused', async () => {
      const agoda = await addSource('Agoda');
      await pool.query(
        `UPDATE inventory_days SET stop_sell = true
         WHERE organization_id = $1 AND date = '2029-03-01'`,
        [orgId],
      );

      const walkIn = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('WALK_IN'))
        .expect(422);
      expect(walkIn.body.error.message).toMatch(/closed on 2029-03-01/);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send(booking('OTA', { bookingSourceId: agoda }))
        .expect(201);
      expect(created.body.overbookings).toEqual([
        expect.objectContaining({ reason: 'RESTRICTION_OVERRIDDEN', dates: ['2029-03-01'] }),
      ]);

      const audit = await pool.query<{ after: { absorbed?: unknown[] } }>(
        "SELECT after FROM audit_logs WHERE action = 'reservation.created' AND entity_id = $1",
        [created.body.id],
      );
      expect(audit.rows[0]?.after.absorbed).toHaveLength(1);

      await pool.query(`UPDATE inventory_days SET stop_sell = false WHERE organization_id = $1`, [
        orgId,
      ]);
    });

    it('lets a manager type a price, and not the front desk', async () => {
      const refused = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asDesk())
        .send({
          ...booking('WALK_IN'),
          stays: [
            {
              roomTypeId,
              ratePlanId,
              checkIn: '2029-03-01',
              checkOut: '2029-03-03',
              adults: 2,
              nightlyRate: 120000,
            },
          ],
        })
        .expect(403);
      expect(refused.body.error.details.capability).toBe('reservation:price_override');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(asOwner())
        .send({
          ...booking('WALK_IN'),
          stays: [
            {
              roomTypeId,
              ratePlanId,
              checkIn: '2029-03-01',
              checkOut: '2029-03-03',
              adults: 2,
              nightlyRate: 120000,
              priceNote: 'Walked in at midnight',
            },
          ],
        })
        .expect(201);
      expect(created.body.stays[0]).toMatchObject({
        pricedFrom: 'MANUAL',
        priceNote: 'Walked in at midnight',
      });
      expect(created.body.subtotal.amount).toBe(240000);
    });

    it('rejects a list filter outside the known categories', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?source=CARRIER_PIGEON`)
        .set(asDesk())
        .expect(422);
    });
  });
});
