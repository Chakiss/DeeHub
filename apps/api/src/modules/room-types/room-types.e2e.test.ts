/**
 * Room type HTTP contract against real PostgreSQL.
 *
 * Covers the two things that would be expensive to get wrong: a code collision
 * has to read as a conflict rather than a 500, and a room type must never be
 * reachable from another organization even with a valid id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Room type e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Room types API', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'room-type-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `rt-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  // A second tenant, used only to prove isolation.
  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `rtx-${otherOrgId.slice(0, 8)}`;
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

    for (const [org, slug, property, propertyCode] of [
      [orgId, orgSlug, propertyId, 'MAIN'],
      [otherOrgId, otherOrgSlug, otherPropertyId, 'MAIN'],
    ] as const) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
        org,
        slug,
        slug,
      ]);
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, $3, $4, 'Asia/Bangkok', 'THB', 'TH')`,
        [property, org, propertyCode, `Hotel ${slug}`],
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
      await pool.query('DELETE FROM room_types WHERE organization_id = $1', [org]);
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

  function body(overrides: Record<string, unknown> = {}) {
    return {
      code: `DLX${Math.floor(Math.random() * 1e6)}`,
      name: 'Deluxe Double',
      standardOccupancy: 2,
      maxOccupancy: 3,
      maxAdults: 3,
      maxChildren: 1,
      ...overrides,
    };
  }

  describe('POST', () => {
    it('creates a room type and returns it', async () => {
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: 'dlx-a', name: '  Deluxe A  ' }))
        .expect(201);

      expect(response.body.code).toBe('DLX-A'); // normalised
      expect(response.body.name).toBe('Deluxe A'); // trimmed
      expect(response.body.isActive).toBe(true);
      expect(response.body.id).toBeTypeOf('string');
    });

    // A duplicate code is a normal thing for a user to do, so it must read as a
    // conflict. Before the driver error was unwrapped this surfaced as a 500.
    it('rejects a duplicate code as a conflict, case-insensitively', async () => {
      const token = await managerToken();
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: 'TWIN' }))
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: 'twin' }))
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('rejects max adults above max occupancy', async () => {
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ maxOccupancy: 2, maxAdults: 3 }))
        .expect(422);

      expect(response.body.error.message).toMatch(/max adults/i);
    });

    it('rejects max occupancy below standard occupancy', async () => {
      const token = await managerToken();
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ standardOccupancy: 4, maxOccupancy: 2, maxAdults: 2 }))
        .expect(422);
    });

    it('rejects a code with characters that would break an OTA mapping', async () => {
      const token = await managerToken();
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: 'DLX ROOM' }))
        .expect(422);
    });

    it('forbids a READ_ONLY user', async () => {
      const token = await tokenFor(`reader-${orgSlug}@e2e.test`, orgSlug);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body())
        .expect(403);

      expect(response.body.error.details.capability).toBe('roomtype:create');
    });

    /**
     * The important one. The propertyId is real and the token is valid — only
     * the tenant differs. A foreign key alone would accept this write.
     */
    it('will not create a room type in another organization property', async () => {
      const token = await managerToken();
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body())
        .expect(404);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM room_types WHERE property_id = $1',
        [otherPropertyId],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('GET', () => {
    it('lists a property in display order, newest last', async () => {
      const token = await managerToken();
      // Codes unique to this run: the assertion must not depend on rows left
      // behind by an earlier crashed run sharing a fixed code.
      // Uppercase to match what the server stores: codes are normalised on
      // write, so a lowercase expectation compares against the wrong string.
      const suffix = orgId.slice(0, 6).toUpperCase();
      const first = `ORD1-${suffix}`;
      const second = `ORD2-${suffix}`;

      const created: Record<string, number> = {};
      for (const code of [first, second]) {
        const response = await request(app.getHttpServer())
          .post(`/api/v1/properties/${propertyId}/room-types`)
          .set('Authorization', `Bearer ${token}`)
          .send(body({ code, name: code }))
          .expect(201);
        created[code] = response.body.sortOrder as number;
      }

      // The contract itself: a new room type lands after the existing ones, so
      // adding one never reshuffles a hotel's arrangement.
      expect(created[second]).toBeGreaterThan(created[first]!);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const items = response.body.items as { code: string; sortOrder: number }[];
      expect(items.map((item) => item.code)).toEqual(expect.arrayContaining([first, second]));

      // Asserted over the whole list rather than two positions: this catches an
      // ordering regression anywhere in it, not just between these two rows.
      const orders = items.map((item) => item.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    it('does not leak another organization room types', async () => {
      const otherToken = await tokenFor(`manager-${otherOrgSlug}@e2e.test`, otherOrgSlug);
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/room-types`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send(body({ code: 'SECRET', name: 'Their Suite' }))
        .expect(201);

      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${otherPropertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.items).toEqual([]);
    });
  });

  describe('PATCH', () => {
    async function create(overrides: Record<string, unknown> = {}): Promise<string> {
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .send(body(overrides))
        .expect(201);
      return response.body.id as string;
    }

    it('updates a name', async () => {
      const id = await create();
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/room-types/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Suite' })
        .expect(200);

      expect(response.body.name).toBe('Renamed Suite');
    });

    /**
     * Validation runs against the row's resulting shape. Sending maxAdults
     * alone is valid or not depending on the stored maxOccupancy, which a
     * check of the patch in isolation cannot see.
     */
    it('validates a partial update against the stored values', async () => {
      const id = await create({ maxOccupancy: 2, maxAdults: 2, standardOccupancy: 2 });
      const token = await managerToken();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/room-types/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ maxAdults: 5 })
        .expect(422);
    });

    it('deactivates rather than deleting', async () => {
      const id = await create();
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/room-types/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);

      expect(response.body.isActive).toBe(false);

      // Still listed: it holds inventory and history, and somebody has to be
      // able to turn it back on.
      const list = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/room-types`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((list.body.items as { id: string }[]).some((item) => item.id === id)).toBe(true);
    });

    it('records deactivation as its own audit action', async () => {
      const id = await create();
      const token = await managerToken();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/room-types/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);

      const { rows } = await pool.query<{ action: string }>(
        'SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1',
        [id],
      );
      expect(rows[0]?.action).toBe('roomtype.deactivated');
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const id = await create();
      const token = await managerToken();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/room-types/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'NEWCODE' })
        .expect(422);
    });

    it('will not update another organization room type', async () => {
      const otherToken = await tokenFor(`manager-${otherOrgSlug}@e2e.test`, otherOrgSlug);
      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/room-types`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send(body({ code: 'THEIRS' }))
        .expect(201);

      const token = await managerToken();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${otherPropertyId}/room-types/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Hijacked' })
        .expect(404);

      const { rows } = await pool.query<{ name: string }>(
        'SELECT name FROM room_types WHERE id = $1',
        [created.body.id],
      );
      expect(rows[0]?.name).not.toBe('Hijacked');
    });
  });
});
