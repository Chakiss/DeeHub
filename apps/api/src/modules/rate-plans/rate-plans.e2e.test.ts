/**
 * Rate plan HTTP contract against real PostgreSQL.
 *
 * The interesting cases are the ones a foreign key alone would allow: attaching
 * a plan to another tenant's room type, and a duplicate code surfacing as a 500
 * rather than a conflict.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Rate plan e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Rate plans API', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'rate-plan-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `rp-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `rpx-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();
  const otherRoomTypeId = crypto.randomUUID();
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

    for (const [org, slug, property, roomType] of [
      [orgId, orgSlug, propertyId, roomTypeId],
      [otherOrgId, otherOrgSlug, otherPropertyId, otherRoomTypeId],
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
      await pool.query(
        `INSERT INTO room_types (id, organization_id, property_id, code, name)
         VALUES ($1, $2, $3, 'DLX', 'Deluxe')`,
        [roomType, org, property],
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
      for (const table of [
        'audit_logs',
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
      roomTypeId,
      code: `BAR${Math.floor(Math.random() * 1e6)}`,
      name: 'Best Available Rate',
      ...overrides,
    };
  }

  it('creates a rate plan with sensible defaults', async () => {
    const token = await managerToken();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body({ code: 'bar-std' }))
      .expect(201);

    expect(response.body.code).toBe('BAR-STD');
    expect(response.body.mealPlan).toBe('ROOM_ONLY');
    expect(response.body.isRefundable).toBe(true);
    expect(response.body.isActive).toBe(true);
    expect(response.body.roomTypeId).toBe(roomTypeId);
  });

  it('accepts a meal plan and a non-refundable flag', async () => {
    const token = await managerToken();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body({ code: 'NRF-BB', mealPlan: 'BREAKFAST', isRefundable: false }))
      .expect(201);

    expect(response.body.mealPlan).toBe('BREAKFAST');
    expect(response.body.isRefundable).toBe(false);
  });

  it('rejects a meal plan the database would refuse', async () => {
    const token = await managerToken();
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body({ mealPlan: 'BRUNCH' }))
      .expect(422);
  });

  it('rejects a duplicate code as a conflict, case-insensitively', async () => {
    const token = await managerToken();
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body({ code: 'DUPE' }))
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body({ code: 'dupe' }))
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
  });

  /**
   * The room type id is real and the token is valid; only the tenant differs.
   * The foreign key would accept this write without complaint.
   */
  it('will not attach a plan to another organization room type', async () => {
    const token = await managerToken();
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body({ roomTypeId: otherRoomTypeId }))
      .expect(404);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM rate_plans WHERE room_type_id = $1',
      [otherRoomTypeId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('forbids a READ_ONLY user from creating one', async () => {
    const token = await tokenFor(`reader-${orgSlug}@e2e.test`, orgSlug);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .send(body())
      .expect(403);

    expect(response.body.error.details.capability).toBe('rateplan:create');
  });

  it('does not leak another organization rate plans', async () => {
    const otherToken = await tokenFor(`manager-${otherOrgSlug}@e2e.test`, otherOrgSlug);
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${otherPropertyId}/rate-plans`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ roomTypeId: otherRoomTypeId, code: 'THEIRS', name: 'Their Rate' })
      .expect(201);

    const token = await managerToken();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/properties/${otherPropertyId}/rate-plans`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.items).toEqual([]);
  });

  describe('PATCH', () => {
    async function create(overrides: Record<string, unknown> = {}): Promise<string> {
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body(overrides))
        .expect(201);
      return response.body.id as string;
    }

    it('renames a plan', async () => {
      const id = await create();
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Rate' })
        .expect(200);

      expect(response.body.name).toBe('Renamed Rate');
    });

    // Both are fixed after creation: the code anchors OTA rate mappings, and
    // the room type is what every priced night was sold under.
    it('refuses to change the code or the room type', async () => {
      const id = await create();
      const token = await managerToken();

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'NEWCODE' })
        .expect(422);

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ roomTypeId: otherRoomTypeId })
        .expect(422);
    });

    it('deactivates rather than deleting, and records it distinctly', async () => {
      const id = await create();
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);

      expect(response.body.isActive).toBe(false);

      const { rows } = await pool.query<{ action: string }>(
        'SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1',
        [id],
      );
      expect(rows[0]?.action).toBe('rateplan.deactivated');
    });

    it('will not update another organization rate plan', async () => {
      const otherToken = await tokenFor(`manager-${otherOrgSlug}@e2e.test`, otherOrgSlug);
      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/rate-plans`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ roomTypeId: otherRoomTypeId, code: 'THEIRS2', name: 'Theirs' })
        .expect(201);

      const token = await managerToken();
      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${otherPropertyId}/rate-plans/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Hijacked' })
        .expect(404);

      const { rows } = await pool.query<{ name: string }>(
        'SELECT name FROM rate_plans WHERE id = $1',
        [created.body.id],
      );
      expect(rows[0]?.name).not.toBe('Hijacked');
    });
  });

  /**
   * A plan priced as an offset from another one.
   *
   * The columns have existed since the first migration and nothing read them,
   * so a derived plan could be stored and would have no prices at all. These
   * cover both halves: that one can be created with rules a hotelier can act
   * on, and that its prices actually resolve.
   */
  describe('derived plans', () => {
    async function createBase(code: string): Promise<string> {
      const token = await managerToken();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code }))
        .expect(201);
      return response.body.id as string;
    }

    function derive(parentId: string, overrides: Record<string, unknown> = {}) {
      return {
        parentRatePlanId: parentId,
        type: 'PERCENTAGE',
        value: -1000,
        ...overrides,
      };
    }

    it('creates a plan that carries an offset instead of prices', async () => {
      const parentId = await createBase(`BASE${Date.now().toString(36)}`);
      const token = await managerToken();

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: `NRF${Date.now().toString(36)}`, derivation: derive(parentId) }))
        .expect(201);

      expect(response.body.parentRatePlanId).toBe(parentId);
      expect(response.body.derivationType).toBe('PERCENTAGE');
      // Rendered once, on the server: three clients would each have to know
      // the unit depends on the type.
      expect(response.body.derivationLabel).toBe('−10%');
    });

    it('prices its nights from the parent', async () => {
      const parentId = await createBase(`P${Date.now().toString(36)}`);
      const token = await managerToken();
      const childResponse = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: `C${Date.now().toString(36)}`, derivation: derive(parentId) }))
        .expect(201);
      const childId = childResponse.body.id as string;

      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy,
                                amount_minor, currency)
         VALUES ($1, $2, $3, '2032-01-01', 2, 200000, 'THB')`,
        [orgId, propertyId, parentId],
      );

      const { rows } = await pool.query<{ amount_minor: string }>(
        `SELECT amount_minor FROM effective_rate_days
          WHERE rate_plan_id = $1 AND date = '2032-01-01' AND occupancy = 2`,
        [childId],
      );
      // 2000.00 less ten percent. The child stores nothing of its own.
      expect(Number(rows[0]?.amount_minor)).toBe(180000);

      const { rows: stored } = await pool.query('SELECT 1 FROM rate_days WHERE rate_plan_id = $1', [
        childId,
      ]);
      expect(stored).toHaveLength(0);
    });

    it('reprices the whole horizon when the offset moves', async () => {
      const parentId = await createBase(`PM${Date.now().toString(36)}`);
      const token = await managerToken();
      const childResponse = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: `CM${Date.now().toString(36)}`, derivation: derive(parentId) }))
        .expect(201);
      const childId = childResponse.body.id as string;

      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy,
                                amount_minor, currency)
         VALUES ($1, $2, $3, '2032-02-01', 2, 200000, 'THB'),
                ($1, $2, $3, '2032-02-02', 2, 200000, 'THB')`,
        [orgId, propertyId, parentId],
      );

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${childId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ derivationValue: -2500 })
        .expect(200);

      const { rows } = await pool.query<{ amount_minor: string }>(
        `SELECT amount_minor FROM effective_rate_days
          WHERE rate_plan_id = $1 AND occupancy = 2 ORDER BY date`,
        [childId],
      );
      // One write, every night. That is the point of a derived plan.
      expect(rows.map((row) => Number(row.amount_minor))).toEqual([150000, 150000]);
    });

    it('gives a night no price at all when the offset wipes it out', async () => {
      const parentId = await createBase(`PZ${Date.now().toString(36)}`);
      const token = await managerToken();
      const childResponse = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(
          body({
            code: `CZ${Date.now().toString(36)}`,
            derivation: derive(parentId, { type: 'AMOUNT', value: -500000 }),
          }),
        )
        .expect(201);

      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy,
                                amount_minor, currency)
         VALUES ($1, $2, $3, '2032-03-01', 2, 200000, 'THB')`,
        [orgId, propertyId, parentId],
      );

      const { rows } = await pool.query(
        'SELECT 1 FROM effective_rate_days WHERE rate_plan_id = $1',
        [childResponse.body.id],
      );
      // Absent, not free. A night with no price cannot be sold, which is the
      // safe reading of an offset somebody typed wrong.
      expect(rows).toHaveLength(0);
    });

    it('refuses a chain of derivations', async () => {
      const parentId = await createBase(`PC${Date.now().toString(36)}`);
      const token = await managerToken();
      const childResponse = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: `CC${Date.now().toString(36)}`, derivation: derive(parentId) }))
        .expect(201);

      // The child holds no prices of its own, so a grandchild would resolve to
      // nothing at all rather than to a compounded discount.
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(
          body({
            code: `GC${Date.now().toString(36)}`,
            derivation: derive(childResponse.body.id as string),
          }),
        )
        .expect(422);
    });

    it('refuses a parent on another room type', async () => {
      const parentId = await createBase(`PX${Date.now().toString(36)}`);
      const token = await managerToken();

      const otherRoomType = crypto.randomUUID();
      await pool.query(
        `INSERT INTO room_types (id, organization_id, property_id, code, name)
         VALUES ($1, $2, $3, $4, 'Standard')`,
        [otherRoomType, orgId, propertyId, `STD${Date.now().toString(36)}`],
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(
          body({
            roomTypeId: otherRoomType,
            code: `CX${Date.now().toString(36)}`,
            derivation: derive(parentId),
          }),
        )
        .expect(422);
    });

    it('refuses an offset that would give the room away', async () => {
      const parentId = await createBase(`PG${Date.now().toString(36)}`);
      const token = await managerToken();

      for (const value of [-10000, 0]) {
        await request(app.getHttpServer())
          .post(`/api/v1/properties/${propertyId}/rate-plans`)
          .set('Authorization', `Bearer ${token}`)
          .send(
            body({
              code: `CG${Date.now().toString(36)}${String(value)}`,
              derivation: derive(parentId, { value }),
            }),
          )
          .expect(422);
      }
    });

    it('refuses prices typed directly onto a derived plan', async () => {
      const parentId = await createBase(`PD${Date.now().toString(36)}`);
      const token = await managerToken();
      const childResponse = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/rate-plans`)
        .set('Authorization', `Bearer ${token}`)
        .send(body({ code: `CD${Date.now().toString(36)}`, derivation: derive(parentId) }))
        .expect(201);

      /*
       * Rows written here would land in `rate_days`, where the view never looks
       * for a derived plan — the editor would show the numbers somebody typed
       * while the plan kept quoting its parent's offset.
       */
      const update = await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          updates: [
            {
              ratePlanId: childResponse.body.id,
              from: '2032-04-01',
              to: '2032-04-02',
              prices: [{ occupancy: 2, amount: 100000 }],
            },
          ],
        })
        .expect(422);
      expect(update.body.error.message).toMatch(/takes its price from its parent/i);

      await request(app.getHttpServer())
        .delete(`/api/v1/properties/${propertyId}/rates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          deletions: [{ ratePlanId: childResponse.body.id, from: '2032-04-01', to: '2032-04-02' }],
        })
        .expect(422);
    });

    it('refuses to change the derivation of a plan that has none', async () => {
      const id = await createBase(`PN${Date.now().toString(36)}`);
      const token = await managerToken();

      await request(app.getHttpServer())
        .patch(`/api/v1/properties/${propertyId}/rate-plans/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ derivationValue: -1000 })
        .expect(422);
    });
  });
});
