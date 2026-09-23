/**
 * Property profile HTTP contract against real PostgreSQL.
 *
 * What a guest and Google see is edited here, so the things worth proving
 * are: the profile is reachable only inside the tenant, coordinates come as
 * a pair, the immutable fields (code, currency, tax) cannot be smuggled in,
 * and a READ_ONLY user can look but not touch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Property e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Properties API', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'property-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `pp-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `ppx-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

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
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
        org,
        slug,
        slug,
      ]);
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, 'MAIN', $3, 'Asia/Bangkok', 'THB', 'TH')`,
        [property, org, `Hotel ${slug}`],
      );
    }

    for (const [id, org, email, role] of [
      [managerId, orgId, `manager-${orgSlug}@e2e.test`, 'MANAGER'],
      [readerId, orgId, `reader-${orgSlug}@e2e.test`, 'READ_ONLY'],
      [otherUserId, otherOrgId, `manager-${otherOrgSlug}@e2e.test`, 'MANAGER'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4, $3)`,
        [id, org, email, hash],
      );
      await pool.query(
        `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
         VALUES ($1, $2, $3, NULL, $4)`,
        [crypto.randomUUID(), org, id, role],
      );
    }
  });

  afterAll(async () => {
    for (const org of [orgId, otherOrgId]) {
      await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [org]);
      await pool.query('DELETE FROM memberships WHERE organization_id = $1', [org]);
      await pool.query('DELETE FROM refresh_tokens WHERE organization_id = $1', [org]);
      await pool.query('DELETE FROM users WHERE organization_id = $1', [org]);
      await pool.query('DELETE FROM properties WHERE organization_id = $1', [org]);
      await pool.query('DELETE FROM organizations WHERE id = $1', [org]);
    }
    await app.close();
  });

  async function tokenFor(email: string, slug: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: slug, email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  const managerToken = () => tokenFor(`manager-${orgSlug}@e2e.test`, orgSlug);

  it('returns the profile with empty marketing fields for a fresh property', async () => {
    const token = await managerToken();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.code).toBe('MAIN');
    expect(response.body.website).toBeNull();
    expect(response.body.latitude).toBeNull();
    expect(response.body.amenities).toEqual([]);
    expect(response.body.checkInTime).toMatch(/^14:00/);
  });

  it('saves address, coordinates, description and times, and audits only what changed', async () => {
    const token = await managerToken();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        addressLine1: '60/11 Huai Yai',
        city: 'Bang Lamung',
        postalCode: '20150',
        phone: '063 548 5456',
        website: 'https://example.com',
        latitude: 12.9236,
        longitude: 100.8825,
        descriptionTh: 'รีสอร์ตเงียบสงบใกล้ห้วยใหญ่',
        descriptionEn: 'A quiet resort near Huai Yai',
        amenities: ['Free Wi-Fi', 'Parking'],
        checkInTime: '15:00',
        checkOutTime: '11:00',
      })
      .expect(200);

    expect(response.body.latitude).toBeCloseTo(12.9236, 6);
    expect(response.body.longitude).toBeCloseTo(100.8825, 6);
    expect(response.body.amenities).toEqual(['Free Wi-Fi', 'Parking']);
    expect(response.body.checkInTime).toMatch(/^15:00/);
    expect(response.body.website).toBe('https://example.com');

    const audit = await pool.query(
      `SELECT before, after FROM audit_logs
        WHERE organization_id = $1 AND action = 'property.updated'
        ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    );
    expect(audit.rowCount).toBe(1);
    const entry = audit.rows[0] as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(entry.after['city']).toBe('Bang Lamung');
    // Untouched fields do not appear on either side.
    expect(entry.after).not.toHaveProperty('name');
    expect(entry.before).not.toHaveProperty('name');
  });

  it('refuses a latitude without a longitude', async () => {
    const token = await managerToken();
    // Clear both first so the stored longitude cannot satisfy the pairing.
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: null, longitude: null })
      .expect(200);

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: 12.9 })
      .expect(422);
    expect(response.body.error.message).toMatch(/longitude/i);
  });

  it('refuses the immutable fields rather than ignoring them', async () => {
    const token = await managerToken();
    for (const body of [
      { code: 'NEW' },
      { currency: 'USD' },
      { taxRateBp: 0 },
      { timezone: 'UTC' },
    ]) {
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(422);
    }
  });

  it('refuses a website that is not a URL and a malformed time', async () => {
    const token = await managerToken();
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ website: 'not a url' })
      .expect(422);
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checkInTime: '3pm' })
      .expect(422);
  });

  it('lets a READ_ONLY user read but not write', async () => {
    const token = await tokenFor(`reader-${orgSlug}@e2e.test`, orgSlug);
    await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed' })
      .expect(403);
    expect(response.body.error.details.capability).toBe('property:update');
  });

  it("never reaches another organization's property, even with its real id", async () => {
    const token = await tokenFor(`manager-${otherOrgSlug}@e2e.test`, otherOrgSlug);
    await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hijacked' })
      .expect(404);

    const untouched = await pool.query('SELECT name FROM properties WHERE id = $1', [propertyId]);
    expect(untouched.rows[0].name).toBe(`Hotel ${orgSlug}`);
  });
});
