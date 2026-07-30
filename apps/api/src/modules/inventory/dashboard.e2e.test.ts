/**
 * Dashboard endpoints over HTTP: inventory grid, bulk edits, rates,
 * availability search and the reservation list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Dashboard tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
process.env.REDIS_URL ??= 'redis://localhost:16379';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('dashboard endpoints', () => {
  let app: INestApplication;
  let pool: Pool;

  const orgId = crypto.randomUUID();
  const orgSlug = `dash-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const otherRoomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const frontDeskId = crypto.randomUUID();

  const PASSWORD = 'dashboard-test-password';
  const DATES = ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05'];

  let managerToken = '';
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

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      orgId,
      'Dashboard Org',
      orgSlug,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency)
       VALUES ($1, $2, 'DASH1', 'Dashboard Property', 'Asia/Bangkok', 'THB')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children, sort_order)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 2, 3, 3, 1, 0),
              ($4, $2, $3, 'STD', 'Standard', 2, 2, 2, 0, 1)`,
      [roomTypeId, orgId, propertyId, otherRoomTypeId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available Rate')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );

    for (const [id, email, name] of [
      [managerId, 'manager@dash.test', 'Manager'],
      [frontDeskId, 'frontdesk@dash.test', 'Front Desk'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, orgId, email, hash, name],
      );
    }
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role) VALUES
        ($1, $2, $3, $4, 'MANAGER'), ($5, $2, $6, $4, 'FRONT_DESK')`,
      [crypto.randomUUID(), orgId, managerId, propertyId, crypto.randomUUID(), frontDeskId],
    );

    managerToken = await login('manager@dash.test');
    frontDeskToken = await login('frontdesk@dash.test');
  });

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  afterAll(async () => {
    for (const table of [
      'outbox_events',
      'audit_logs',
      'reservations',
      'inventory_days',
      'rate_days',
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

  async function seed(allotment = 5): Promise<void> {
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);

    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [orgId, propertyId, roomTypeId, date, allotment],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 250000, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy],
        );
      }
    }
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await seed();
  });

  describe('GET /inventory', () => {
    it('returns a dense grid with one entry per room type per night', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-01&to=2027-03-04`)
        .set(auth(frontDeskToken))
        .expect(200);

      expect(response.body.roomTypes).toHaveLength(2);
      const deluxe = response.body.roomTypes.find((row: { code: string }) => row.code === 'DLX');
      expect(deluxe.days).toHaveLength(3);
      expect(deluxe.days[0]).toMatchObject({
        date: '2027-03-01',
        allotment: 5,
        booked: 0,
        available: 5,
        open: true,
      });
    });

    it('marks a night with no row as closed, not blank', async () => {
      // A date that was never opened must never look sellable.
      const standard = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-01&to=2027-03-02`)
        .set(auth(frontDeskToken))
        .expect(200);

      const row = standard.body.roomTypes.find((r: { code: string }) => r.code === 'STD');
      expect(row.days[0]).toMatchObject({ open: false, available: 0, allotment: 0 });
    });

    it('carries the lead price at the room type standard occupancy', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-01&to=2027-03-02`)
        .set(auth(frontDeskToken))
        .expect(200);

      const deluxe = response.body.roomTypes.find((row: { code: string }) => row.code === 'DLX');
      // Standard occupancy is 2, and only the occupancy-2 price is the one a
      // guest would be quoted for the room as sold.
      expect(deluxe.days[0].rate).toMatchObject({
        amountMinor: 250000,
        currency: 'THB',
        planCount: 1,
      });
    });

    /**
     * The combination worth catching. A night with rooms and no price looks
     * bookable everywhere else and then fails with RATE_MISSING when a guest
     * tries, so the grid has to be able to say so.
     */
    it('reports a night that is open for sale but has no price', async () => {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, '2027-03-01', 4, 0)`,
        [orgId, propertyId, otherRoomTypeId],
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-01&to=2027-03-02`)
        .set(auth(frontDeskToken))
        .expect(200);

      const standard = response.body.roomTypes.find((row: { code: string }) => row.code === 'STD');
      expect(standard.days[0]).toMatchObject({ open: true, available: 4, rate: null });
    });

    it('takes the lowest price when several plans plan the same night', async () => {
      const cheaperPlanId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
         VALUES ($1, $2, $3, $4, 'NRF', 'Non-refundable')`,
        [cheaperPlanId, orgId, propertyId, roomTypeId],
      );
      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
         VALUES ($1, $2, $3, '2027-03-01', 2, 199000, 'THB')`,
        [orgId, propertyId, cheaperPlanId],
      );

      try {
        const response = await request(app.getHttpServer())
          .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-01&to=2027-03-02`)
          .set(auth(frontDeskToken))
          .expect(200);

        const deluxe = response.body.roomTypes.find((row: { code: string }) => row.code === 'DLX');
        // The "from" price an OTA advertises, and planCount so a single figure
        // standing for several plans is visible as such.
        expect(deluxe.days[0].rate).toMatchObject({ amountMinor: 199000, planCount: 2 });
      } finally {
        await pool.query('DELETE FROM rate_days WHERE rate_plan_id = $1', [cheaperPlanId]);
        await pool.query('DELETE FROM rate_plans WHERE id = $1', [cheaperPlanId]);
      }
    });

    it('ignores a deactivated rate plan', async () => {
      const retiredId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name, is_active)
         VALUES ($1, $2, $3, $4, 'OLD', 'Retired', false)`,
        [retiredId, orgId, propertyId, roomTypeId],
      );
      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
         VALUES ($1, $2, $3, '2027-03-01', 2, 1000, 'THB')`,
        [orgId, propertyId, retiredId],
      );

      try {
        const response = await request(app.getHttpServer())
          .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-01&to=2027-03-02`)
          .set(auth(frontDeskToken))
          .expect(200);

        const deluxe = response.body.roomTypes.find((row: { code: string }) => row.code === 'DLX');
        // A price nobody can book must not become the number on the screen.
        expect(deluxe.days[0].rate).toMatchObject({ amountMinor: 250000, planCount: 1 });
      } finally {
        await pool.query('DELETE FROM rate_days WHERE rate_plan_id = $1', [retiredId]);
        await pool.query('DELETE FROM rate_plans WHERE id = $1', [retiredId]);
      }
    });

    it('rejects an inverted or oversized range', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/inventory?from=2027-03-05&to=2027-03-01`)
        .set(auth(frontDeskToken))
        .expect(422);

      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/inventory?from=2027-01-01&to=2029-01-01`)
        .set(auth(frontDeskToken))
        .expect(422);
    });
  });

  describe('PATCH /inventory', () => {
    it('applies allotment across a range and emits a sync event', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(managerToken))
        .send({
          updates: [{ roomTypeId, from: '2027-03-01', to: '2027-03-04', allotment: 9 }],
        })
        .expect(200);

      expect(response.body).toMatchObject({ nightsUpdated: 3, roomTypesTouched: 1 });

      const rows = await pool.query<{ allotment: number }>(
        'SELECT allotment FROM inventory_days WHERE room_type_id = $1 AND date < $2 ORDER BY date',
        [roomTypeId, '2027-03-04'],
      );
      expect(rows.rows.map((r) => r.allotment)).toEqual([9, 9, 9]);

      // The channel manager must learn about it.
      const events = await pool.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_events WHERE organization_id = $1',
        [orgId],
      );
      expect(events.rows.map((r) => r.event_type)).toContain('inventory.changed');
    });

    it('applies only to the requested weekdays', async () => {
      // 2027-03-05 is a Friday, 2027-03-06 a Saturday.
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(managerToken))
        .send({
          updates: [
            {
              roomTypeId,
              from: '2027-03-01',
              to: '2027-03-08',
              daysOfWeek: ['FRI', 'SAT'],
              allotment: 2,
            },
          ],
        })
        .expect(200);

      const rows = await pool.query<{ date: string; allotment: number }>(
        `SELECT date::text AS date, allotment FROM inventory_days
          WHERE room_type_id = $1 AND date BETWEEN '2027-03-01' AND '2027-03-07' ORDER BY date`,
        [roomTypeId],
      );
      const byDate = new Map(rows.rows.map((r) => [r.date, r.allotment]));
      expect(byDate.get('2027-03-05')).toBe(2); // Friday
      expect(byDate.get('2027-03-06')).toBe(2); // Saturday
      expect(byDate.get('2027-03-04')).toBe(5); // Thursday, untouched
    });

    it('creates nights that did not exist yet', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(managerToken))
        .send({
          updates: [
            { roomTypeId: otherRoomTypeId, from: '2027-03-01', to: '2027-03-03', allotment: 4 },
          ],
        })
        .expect(200);

      const rows = await pool.query('SELECT 1 FROM inventory_days WHERE room_type_id = $1', [
        otherRoomTypeId,
      ]);
      expect(rows.rowCount).toBe(2);
    });

    it('sets restrictions without resetting allotment', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(managerToken))
        .send({
          updates: [
            { roomTypeId, from: '2027-03-01', to: '2027-03-02', minStay: 3, stopSell: true },
          ],
        })
        .expect(200);

      const row = await pool.query<{ allotment: number; min_stay: number; stop_sell: boolean }>(
        'SELECT allotment, min_stay, stop_sell FROM inventory_days WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2027-03-01'],
      );
      // Allotment untouched — a min-stay edit must not wipe the calendar.
      expect(row.rows[0]).toMatchObject({ allotment: 5, min_stay: 3, stop_sell: true });
    });

    it('refuses to drop allotment below what is already sold, naming the dates', async () => {
      await pool.query(
        'UPDATE inventory_days SET booked = 3 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2027-03-02'],
      );

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(managerToken))
        .send({ updates: [{ roomTypeId, from: '2027-03-01', to: '2027-03-04', allotment: 1 }] })
        .expect(409);

      expect(response.body.error.code).toBe('ALLOTMENT_BELOW_BOOKED');
      expect(response.body.error.details.conflicts[0]).toMatchObject({
        date: '2027-03-02',
        booked: 3,
      });

      // Nothing applied: the whole request is one transaction.
      const rows = await pool.query<{ allotment: number }>(
        'SELECT allotment FROM inventory_days WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2027-03-01'],
      );
      expect(rows.rows[0]?.allotment).toBe(5);
    });

    it('forbids a front-desk user from editing inventory', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(frontDeskToken))
        .send({ updates: [{ roomTypeId, from: '2027-03-01', to: '2027-03-02', allotment: 1 }] })
        .expect(403);
      expect(response.body.error.details.capability).toBe('inventory:update');
    });

    it('rejects an update that changes nothing', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/inventory`)
        .set(auth(managerToken))
        .send({ updates: [{ roomTypeId, from: '2027-03-01', to: '2027-03-02' }] })
        .expect(422);
    });
  });

  describe('PATCH /rates', () => {
    it('sets prices across a range and emits a rate event', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rates`)
        .set(auth(managerToken))
        .send({
          updates: [
            {
              ratePlanId,
              from: '2027-03-01',
              to: '2027-03-03',
              prices: [{ occupancy: 2, amount: 450000 }],
            },
          ],
        })
        .expect(200);

      expect(response.body.pricesUpdated).toBe(2);

      const rows = await pool.query<{ amount_minor: string }>(
        `SELECT amount_minor FROM rate_days
          WHERE rate_plan_id = $1 AND occupancy = 2 AND date = '2027-03-01'`,
        [ratePlanId],
      );
      expect(Number(rows.rows[0]?.amount_minor)).toBe(450000);

      const events = await pool.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_events WHERE organization_id = $1',
        [orgId],
      );
      expect(events.rows.map((r) => r.event_type)).toContain('rate.changed');
    });

    it('rejects a decimal amount — prices are integer minor units', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rates`)
        .set(auth(managerToken))
        .send({
          updates: [
            {
              ratePlanId,
              from: '2027-03-01',
              to: '2027-03-02',
              prices: [{ occupancy: 2, amount: 2500.5 }],
            },
          ],
        })
        .expect(422);
    });

    it('returns 404 for a rate plan in another property', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rates`)
        .set(auth(managerToken))
        .send({
          updates: [
            {
              ratePlanId: crypto.randomUUID(),
              from: '2027-03-01',
              to: '2027-03-02',
              prices: [{ occupancy: 2, amount: 100000 }],
            },
          ],
        })
        .expect(404);
    });
  });

  describe('GET /availability', () => {
    it('returns sellable room types with per-night pricing', async () => {
      const response = await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/availability?checkIn=2027-03-01&checkOut=2027-03-03&adults=2`,
        )
        .set(auth(frontDeskToken))
        .expect(200);

      expect(response.body.nights).toBe(2);
      const deluxe = response.body.roomTypes.find((r: { code: string }) => r.code === 'DLX');
      expect(deluxe.availableUnits).toBe(5);
      expect(deluxe.ratePlans[0]).toMatchObject({
        bookable: true,
        total: { amount: 500000, currency: 'THB' },
      });
    });

    it('explains WHY a room type is unavailable instead of hiding it', async () => {
      await pool.query(
        'UPDATE inventory_days SET min_stay = 5 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2027-03-01'],
      );

      const response = await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/availability?checkIn=2027-03-01&checkOut=2027-03-03&adults=2`,
        )
        .set(auth(frontDeskToken))
        .expect(200);

      const blocked = response.body.unavailable.find(
        (row: { roomTypeId: string }) => row.roomTypeId === roomTypeId,
      );
      expect(blocked).toMatchObject({
        reason: 'RESTRICTION_VIOLATED',
        detail: { restriction: 'MIN_STAY', required: 5 },
      });
    });

    it('reports an occupancy that exceeds the room type', async () => {
      const response = await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/availability?checkIn=2027-03-01&checkOut=2027-03-02&adults=10`,
        )
        .set(auth(frontDeskToken))
        .expect(200);

      expect(
        response.body.unavailable.every(
          (row: { reason: string }) => row.reason === 'OCCUPANCY_EXCEEDED',
        ),
      ).toBe(true);
      expect(response.body.roomTypes).toHaveLength(0);
    });

    it('takes the MINIMUM availability across the stay', async () => {
      await pool.query(
        'UPDATE inventory_days SET booked = 4 WHERE room_type_id = $1 AND date = $2',
        [roomTypeId, '2027-03-02'],
      );

      const response = await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/availability?checkIn=2027-03-01&checkOut=2027-03-03&adults=2`,
        )
        .set(auth(frontDeskToken))
        .expect(200);

      const deluxe = response.body.roomTypes.find((r: { code: string }) => r.code === 'DLX');
      // A stay is only sellable if EVERY night has a unit free.
      expect(deluxe.availableUnits).toBe(1);
    });

    it('rejects a zero-night stay', async () => {
      await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/availability?checkIn=2027-03-01&checkOut=2027-03-01&adults=2`,
        )
        .set(auth(frontDeskToken))
        .expect(422);
    });
  });

  describe('GET /reservations', () => {
    async function book(guestName: string, checkIn: string, checkOut: string): Promise<string> {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth(frontDeskToken))
        .send({
          source: 'WALK_IN',
          booker: { name: guestName },
          stays: [{ roomTypeId, ratePlanId, checkIn, checkOut, adults: 2 }],
        })
        .expect(201);
      return response.body.code as string;
    }

    it('lists reservations newest first with a summary per row', async () => {
      await book('Alice', '2027-03-01', '2027-03-03');
      await book('Bob', '2027-03-02', '2027-03-04');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth(frontDeskToken))
        .expect(200);

      expect(response.body.items).toHaveLength(2);
      expect(response.body.items[0].bookerName).toBe('Bob');
      // rooms/nights/dates come from correlated subqueries; a shadowed column
      // reference silently returned zeroes here once.
      expect(response.body.items[0]).toMatchObject({
        rooms: 1,
        nights: 2,
        checkIn: '2027-03-02',
        checkOut: '2027-03-04',
      });
      expect(response.body.pageInfo.hasMore).toBe(false);
    });

    it('pages with a stable cursor', async () => {
      for (const name of ['A', 'B', 'C']) {
        await book(name, '2027-03-01', '2027-03-02');
      }

      const first = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?limit=2`)
        .set(auth(frontDeskToken))
        .expect(200);

      expect(first.body.items).toHaveLength(2);
      expect(first.body.pageInfo.hasMore).toBe(true);

      const second = await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/reservations?limit=2&cursor=${encodeURIComponent(
            first.body.pageInfo.nextCursor as string,
          )}`,
        )
        .set(auth(frontDeskToken))
        .expect(200);

      expect(second.body.items).toHaveLength(1);
      // No overlap between pages.
      const firstIds = first.body.items.map((row: { id: string }) => row.id);
      expect(firstIds).not.toContain(second.body.items[0].id);
    });

    it('filters by guest name', async () => {
      await book('Somchai Prasert', '2027-03-01', '2027-03-02');
      await book('Nattapong S', '2027-03-01', '2027-03-02');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?q=somchai`)
        .set(auth(frontDeskToken))
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].bookerName).toBe('Somchai Prasert');
    });

    it('filters by arrival window without duplicating multi-stay reservations', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth(frontDeskToken))
        .send({
          source: 'WALK_IN',
          booker: { name: 'Two Rooms' },
          stays: [
            { roomTypeId, ratePlanId, checkIn: '2027-03-01', checkOut: '2027-03-02', adults: 2 },
            { roomTypeId, ratePlanId, checkIn: '2027-03-01', checkOut: '2027-03-02', adults: 2 },
          ],
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(
          `/api/v1/properties/${propertyId}/reservations?checkInFrom=2027-03-01&checkInTo=2027-03-01`,
        )
        .set(auth(frontDeskToken))
        .expect(200);

      // One reservation, two rooms — not two rows.
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].rooms).toBe(2);
    });

    it('filters by status', async () => {
      const code = await book('Cancel Me', '2027-03-01', '2027-03-02');
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?q=${code}`)
        .set(auth(frontDeskToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(
          `/api/v1/properties/${propertyId}/reservations/${listed.body.items[0].id as string}/cancel`,
        )
        .set(auth(frontDeskToken))
        .send({ version: 0 })
        .expect(200);

      const cancelled = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?status=CANCELLED`)
        .set(auth(frontDeskToken))
        .expect(200);
      expect(cancelled.body.items).toHaveLength(1);

      const confirmed = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?status=CONFIRMED`)
        .set(auth(frontDeskToken))
        .expect(200);
      expect(confirmed.body.items).toHaveLength(0);
    });

    it('rejects a malformed cursor as a client error, not a 500', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations?cursor=not-a-cursor`)
        .set(auth(frontDeskToken))
        .expect(422);
    });
  });
});
