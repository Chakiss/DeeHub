/**
 * The audit trail read back over HTTP.
 *
 * Every write in this system has been recorded since the first migration and
 * nothing could read it. These check the parts that make it usable rather than
 * merely present: ordering, paging that does not skip, and the organization-wide
 * entries that an audit is usually opened to find.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Audit e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Audit trail', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'audit-e2e-password';
  const orgId = crypto.randomUUID();
  const orgSlug = `au-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `aux-${otherOrgId.slice(0, 8)}`;

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

    for (const [org, slug] of [
      [orgId, orgSlug],
      [otherOrgId, otherOrgSlug],
    ] as const) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
        org,
        slug,
      ]);
    }
    for (const [property, org, code] of [
      [propertyId, orgId, 'MAIN'],
      [otherPropertyId, orgId, 'SECOND'],
    ] as const) {
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, $3, 'Audit Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
        [property, org, code],
      );
    }
    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $3)`,
      [
        ownerId,
        orgId,
        `owner-${orgSlug}@e2e.test`,
        await new ScryptPasswordHasher().hash(PASSWORD),
      ],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
       VALUES ($1, $2, $3, NULL, 'OWNER')`,
      [crypto.randomUUID(), orgId, ownerId],
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email: `owner-${orgSlug}@e2e.test`, password: PASSWORD })
      .expect(200);
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    for (const org of [orgId, otherOrgId]) {
      for (const table of ['audit_logs', 'memberships', 'refresh_tokens', 'users', 'properties']) {
        await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
      }
      await pool.query('DELETE FROM organizations WHERE id = $1', [org]);
    }
    await app.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [otherOrgId]);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function record(
    action: string,
    options: { property?: string | null; at?: string; entityType?: string; org?: string } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO audit_logs (id, organization_id, property_id, actor_type, actor_label,
                               action, entity_type, entity_id, created_at)
       VALUES ($1, $2, $3, 'USER', 'somebody', $4, $5, $6, coalesce($7::timestamptz, now()))`,
      [
        crypto.randomUUID(),
        options.org ?? orgId,
        options.property === undefined ? propertyId : options.property,
        action,
        options.entityType ?? 'reservation',
        crypto.randomUUID(),
        options.at ?? null,
      ],
    );
  }

  function get(query = '') {
    return request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/audit${query}`)
      .set(auth());
  }

  it('returns entries newest first', async () => {
    await record('reservation.created', { at: '2028-01-01T10:00:00Z' });
    await record('reservation.cancelled', { at: '2028-01-02T10:00:00Z' });

    const response = await get().expect(200);
    expect(response.body.items.map((item: { action: string }) => item.action)).toEqual([
      'reservation.cancelled',
      'reservation.created',
    ]);
  });

  /**
   * Team and guest changes carry a null propertyId because they are not about
   * one hotel. Filtering them out would hide exactly what an audit is usually
   * opened to find — who changed whose role — while looking complete.
   */
  it('includes organization-wide entries alongside the property ones', async () => {
    await record('reservation.created');
    await record('user.role_changed', { property: null, entityType: 'user' });

    const response = await get().expect(200);
    const actions = response.body.items.map((item: { action: string }) => item.action);
    expect(actions).toContain('user.role_changed');
  });

  it('excludes another property in the same organization', async () => {
    await pool.query(
      `INSERT INTO audit_logs (id, organization_id, property_id, actor_type, action,
                               entity_type, entity_id)
       VALUES ($1, $2, $3, 'USER', 'rate.updated', 'rate_plan', $4)`,
      [crypto.randomUUID(), orgId, otherPropertyId, crypto.randomUUID()],
    );

    const response = await get().expect(200);
    expect(response.body.items).toHaveLength(0);
  });

  it('never shows another organization', async () => {
    await record('reservation.created', { org: otherOrgId, property: null });
    const response = await get().expect(200);
    expect(response.body.items).toHaveLength(0);
  });

  it('filters by action and by entity', async () => {
    await record('reservation.created');
    await record('rate.updated', { entityType: 'rate_plan' });

    const byAction = await get('?action=rate.updated').expect(200);
    expect(byAction.body.items).toHaveLength(1);

    const byEntity = await get('?entityType=rate_plan').expect(200);
    expect(byEntity.body.items).toHaveLength(1);
  });

  /**
   * Keyset, not OFFSET. Entries land constantly, and an offset would skip or
   * repeat rows as the page moves.
   */
  it('pages without skipping or repeating', async () => {
    for (let i = 0; i < 5; i += 1) {
      await record('reservation.created', {
        at: `2028-02-0${String(i + 1)}T10:00:00Z`,
      });
    }

    // Two at a time, so this genuinely pages. An earlier version of this test
    // passed a limit the controller ignored, so all five came back at once and
    // the loop proved nothing.
    const first = await get('?limit=2').expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.pageInfo.hasMore).toBe(true);

    // Walk it a page at a time and confirm every id appears exactly once.
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const response: {
        body: { items: { id: string }[]; pageInfo: { nextCursor: string | null } };
      } = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/audit?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(auth())
        .expect(200);

      for (const item of response.body.items) {
        expect(seen.has(item.id), 'an entry appeared on two pages').toBe(false);
        seen.add(item.id);
      }
      cursor = response.body.pageInfo.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(5);
  });

  it('rejects a malformed cursor as a client error, not a 500', async () => {
    await get('?cursor=not-a-cursor').expect(422);
  });
});
