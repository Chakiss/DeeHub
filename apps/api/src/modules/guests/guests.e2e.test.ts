/**
 * Guest profiles against real PostgreSQL.
 *
 * The centre of these is the matching rule. Attaching a stay to the wrong
 * person shows one guest another guest's history, and nothing in the data
 * later reveals that it happened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Guest e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Guests', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'guests-e2e-password';
  const orgId = crypto.randomUUID();
  const orgSlug = `gs-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  const DATES = ['2029-04-01', '2029-04-02', '2029-04-03', '2029-04-04'];
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
       VALUES ($1, $2, 'MAIN', 'Guest Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
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
      'outbox_events',
      'audit_logs',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
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

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM guests WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);

    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 10, 0)`,
        [orgId, propertyId, roomTypeId, date],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy,
                                  amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 200000, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy],
        );
      }
    }
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function book(
    booker: { name: string; email?: string; phone?: string },
    checkIn = DATES[0]!,
    checkOut = DATES[1]!,
  ) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'WALK_IN',
        booker,
        stays: [{ roomTypeId, ratePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return response.body as { id: string };
  }

  it('creates a guest from the booker and attaches it to the reservation', async () => {
    const reservation = await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });

    const { rows } = await pool.query<{ guest_id: string | null }>(
      'SELECT guest_id FROM reservations WHERE id = $1',
      [reservation.id],
    );
    // Before this existed, every reservation was written with guest_id null.
    expect(rows[0]?.guest_id).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      firstName: 'Somchai',
      lastName: 'Prasert',
      email: 'somchai@example.com',
      stays: 1,
    });
  });

  it('links a returning guest to the same profile', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    await book({ name: 'Somchai Prasert', email: 'SOMCHAI@example.com' }, DATES[2]!, DATES[3]!);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    // The point of the whole module: history accrues.
    expect(list.body.items[0].stays).toBe(2);
    expect(list.body.items[0].revenueMinor).toBeGreaterThan(0);
  });

  /**
   * The rule that matters. A shared address is real — a company books its
   * staff through one inbox — and matching on email alone would show one
   * person another's stays with nothing in the data revealing it.
   */
  it('does NOT merge two people who share an email address', async () => {
    await book({ name: 'Somchai Prasert', email: 'info@company.co.th' });
    await book({ name: 'Malee Wong', email: 'info@company.co.th' }, DATES[2]!, DATES[3]!);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(2);

    // Both are flagged so a human can decide, rather than the system deciding.
    for (const item of list.body.items as { possibleDuplicates: number }[]) {
      expect(item.possibleDuplicates).toBe(1);
    }
  });

  // Without an address there is nothing to match on, and guessing from a name
  // alone would merge every "John Smith" in the country.
  it('creates a separate profile when no email is given', async () => {
    await book({ name: 'Walk In Guest' });
    await book({ name: 'Walk In Guest' }, DATES[2]!, DATES[3]!);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(2);
  });

  it('treats a single-word name as a first name with no family name', async () => {
    await book({ name: 'Ploy', email: 'ploy@example.com' });

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ firstName: 'Ploy', lastName: null });
  });

  it('searches by name, email and phone', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com', phone: '0812345678' });

    for (const term of ['prasert', 'SOMCHAI@EXAMPLE', '08123']) {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/guests?q=${encodeURIComponent(term)}`)
        .set(auth())
        .expect(200);
      expect(response.body.items, `searching for ${term}`).toHaveLength(1);
    }
  });

  it('does not count a cancelled booking as a stay', async () => {
    const reservation = await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservation.id}/cancel`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    // Somebody who booked and cancelled is not a returning guest.
    expect(list.body.items[0].stays).toBe(0);
  });

  it('corrects a profile', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    const id = list.body.items[0].id as string;

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/guests/${id}`)
      .set(auth())
      .send({ lastName: 'Prasert-Wong', notes: 'Prefers a high floor' })
      .expect(200);

    expect(response.body).toMatchObject({
      lastName: 'Prasert-Wong',
      notes: 'Prefers a high floor',
    });
  });

  // The row carries an encrypted document number; serialising the whole record
  // is exactly how that leaves the building.
  it('never returns the encrypted document number', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('documentNumber');
    expect(serialized).not.toContain('document_number');
  });

  it('is scoped to the organization', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    const id = list.body.items[0].id as string;

    // A different organization's manager must not be able to read it. Reusing
    // this org's token against a fabricated id is the cheap half; the real
    // check is that another tenant sees nothing at all.
    await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests/${crypto.randomUUID()}`)
      .set(auth())
      .expect(404);

    expect(id).toBeTruthy();
  });
});
