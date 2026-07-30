/**
 * User administration against real PostgreSQL.
 *
 * Most of these are about authority rather than CRUD: an organization must not
 * be able to hand out more power than the actor holds, and must not be able to
 * lock itself out. Neither rule is expressible as a capability check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. User e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Users API', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'user-admin-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `us-${orgId.slice(0, 8)}`;
  const ownerId = crypto.randomUUID();
  const secondOwnerId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `usx-${otherOrgId.slice(0, 8)}`;
  const otherOwnerId = crypto.randomUUID();

  const email = (id: string) => `${id}@e2e.test`;

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

    for (const [org, slug] of [
      [orgId, orgSlug],
      [otherOrgId, otherOrgSlug],
    ] as const) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
        org,
        slug,
      ]);
    }

    for (const [id, org, role] of [
      [ownerId, orgId, 'OWNER'],
      [secondOwnerId, orgId, 'OWNER'],
      [adminId, orgId, 'ADMIN'],
      [managerId, orgId, 'MANAGER'],
      [otherOwnerId, otherOrgId, 'OWNER'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4, $3)`,
        [id, org, email(id), hash],
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
      for (const table of ['audit_logs', 'memberships', 'refresh_tokens', 'users']) {
        await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
      }
      await pool.query('DELETE FROM organizations WHERE id = $1', [org]);
    }
    await app.close();
  });

  async function tokenFor(userId: string, slug = orgSlug): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: slug, email: email(userId), password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  function invite(overrides: Record<string, unknown> = {}) {
    return {
      email: `new-${crypto.randomUUID().slice(0, 8)}@e2e.test`,
      fullName: 'New Colleague',
      role: 'FRONT_DESK',
      ...overrides,
    };
  }

  describe('inviting', () => {
    it('creates an account and returns a one-time password that works', async () => {
      const token = await tokenFor(ownerId);
      const body = invite();

      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      expect(response.body.temporaryPassword).toBeTypeOf('string');
      expect(response.body.memberships[0].role).toBe('FRONT_DESK');

      // The credential has to actually work, or the invite is theatre.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          organizationSlug: orgSlug,
          email: body.email,
          password: response.body.temporaryPassword,
        })
        .expect(200);
    });

    it('never writes the password into the audit trail', async () => {
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite())
        .expect(201);

      const { rows } = await pool.query<{ after: unknown }>(
        "SELECT after FROM audit_logs WHERE action = 'user.invited' AND entity_id = $1",
        [response.body.id],
      );
      expect(JSON.stringify(rows[0])).not.toContain(response.body.temporaryPassword);
    });

    /**
     * The rule a capability check cannot express: an ADMIN legitimately holds
     * `user:invite`, and without this could mint an OWNER and then be
     * administered by the account they just created.
     */
    it('refuses to let an ADMIN create an OWNER', async () => {
      const token = await tokenFor(adminId);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite({ role: 'OWNER' }))
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('lets an ADMIN create roles at or below its own level', async () => {
      const token = await tokenFor(adminId);
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite({ role: 'ADMIN' }))
        .expect(201);
    });

    it('forbids a MANAGER from inviting at all', async () => {
      const token = await tokenFor(managerId);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite())
        .expect(403);

      expect(response.body.error.details.capability).toBe('user:invite');
    });

    it('rejects a duplicate email as a conflict', async () => {
      const token = await tokenFor(ownerId);
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite({ email: email(ownerId) }))
        .expect(409);
    });
  });

  describe('changing role and status', () => {
    async function createColleague(role = 'FRONT_DESK'): Promise<string> {
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite({ role }))
        .expect(201);
      return response.body.id as string;
    }

    it('changes a role', async () => {
      const id = await createColleague();
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'MANAGER' })
        .expect(200);

      expect(response.body.memberships[0].role).toBe('MANAGER');
    });

    it('disables an account instead of deleting it, and login then fails', async () => {
      const id = await createColleague();
      const token = await tokenFor(ownerId);
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'DISABLED' })
        .expect(200);

      const { rows } = await pool.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [id],
      );
      // The row survives: audit entries and reservations point at it.
      expect(rows).toHaveLength(1);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: rows[0]!.email, password: PASSWORD })
        .expect(401);
    });

    it('refuses to let an ADMIN disable an OWNER', async () => {
      const token = await tokenFor(adminId);
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${ownerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'DISABLED' })
        .expect(403);
    });

    // Locking yourself out is always a mistake, never an intent.
    it('refuses to let anyone change their own role or status', async () => {
      const token = await tokenFor(ownerId);
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${ownerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'DISABLED' })
        .expect(422);

      await request(app.getHttpServer())
        .patch(`/api/v1/users/${ownerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'READ_ONLY' })
        .expect(422);
    });

    it('allows renaming yourself — that locks nobody out', async () => {
      const token = await tokenFor(ownerId);
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${ownerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Renamed Owner' })
        .expect(200);
    });

    /**
     * Named for what it actually proves. An earlier version of this called
     * itself a last-owner test and passed with the last-owner guard removed,
     * because seniority rejects the request first — only an owner may demote an
     * owner. The guard itself is unit-tested in user.rules.test.ts, where it
     * can fail.
     */
    it('lets only another owner demote an owner', async () => {
      const adminToken = await tokenFor(adminId);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${ownerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'ADMIN' })
        .expect(403);
      expect(response.body.error.code).toBe('FORBIDDEN');

      // A peer owner may, and the demoted account keeps working at its new level.
      const ownerToken = await tokenFor(ownerId);
      const demoted = await request(app.getHttpServer())
        .patch(`/api/v1/users/${secondOwnerId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'ADMIN' })
        .expect(200);
      expect(demoted.body.memberships[0].role).toBe('ADMIN');

      // Restore for the remaining tests.
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${secondOwnerId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'OWNER' })
        .expect(200);
    });
  });

  describe('resetting a password', () => {
    async function createColleague(): Promise<{ id: string; email: string }> {
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send(invite())
        .expect(201);
      return { id: response.body.id as string, email: response.body.email as string };
    }

    it('issues a working password and retires the old one', async () => {
      const colleague = await createColleague();
      const token = await tokenFor(ownerId);

      const reset = await request(app.getHttpServer())
        .post(`/api/v1/users/${colleague.id}/reset-password`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(reset.body.temporaryPassword).toBeTypeOf('string');

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          organizationSlug: orgSlug,
          email: colleague.email,
          password: reset.body.temporaryPassword,
        })
        .expect(200);
    });

    /**
     * The reason a password gets reset is often that someone else has it.
     * Leaving their refresh token alive would hand access straight back.
     */
    it('revokes sessions the account already had', async () => {
      const colleague = await createColleague();
      const ownerToken = await tokenFor(ownerId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/users/${colleague.id}/reset-password`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      // Sign in, then reset again — the first session must die.
      const session = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          organizationSlug: orgSlug,
          email: colleague.email,
          password: created.body.temporaryPassword,
        })
        .expect(200);
      const cookie = (session.headers['set-cookie'] as unknown as string[])[0] ?? '';

      await request(app.getHttpServer())
        .post(`/api/v1/users/${colleague.id}/reset-password`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
    });

    /**
     * A security rule, not a nicety. Changing your own password goes through
     * /auth/change-password, which demands the current one — if this accepted
     * self, a stolen access token would be enough to lock the real owner out.
     */
    it('refuses to reset your own password', async () => {
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${ownerId}/reset-password`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(response.body.error.message).toMatch(/current password/i);

      // And the existing credential still works — nothing was changed.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: email(ownerId), password: PASSWORD })
        .expect(200);
    });

    it('refuses to let an ADMIN reset an OWNER password', async () => {
      const token = await tokenFor(adminId);
      await request(app.getHttpServer())
        .post(`/api/v1/users/${ownerId}/reset-password`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('forbids a MANAGER entirely', async () => {
      const colleague = await createColleague();
      const token = await tokenFor(managerId);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${colleague.id}/reset-password`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(response.body.error.details.capability).toBe('user:update');
    });

    it('keeps the new password out of the audit trail', async () => {
      const colleague = await createColleague();
      const token = await tokenFor(ownerId);
      const reset = await request(app.getHttpServer())
        .post(`/api/v1/users/${colleague.id}/reset-password`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const { rows } = await pool.query(
        "SELECT after FROM audit_logs WHERE action = 'user.password_reset' AND entity_id = $1",
        [colleague.id],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(reset.body.temporaryPassword);
    });

    it('will not reset a password in another organization', async () => {
      const token = await tokenFor(ownerId);
      await request(app.getHttpServer())
        .post(`/api/v1/users/${otherOwnerId}/reset-password`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      // Their credential is untouched.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: otherOrgSlug, email: email(otherOwnerId), password: PASSWORD })
        .expect(200);
    });
  });

  describe('tenancy', () => {
    it('lists only this organization', async () => {
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const emails = (response.body.items as { email: string }[]).map((item) => item.email);
      expect(emails).toContain(email(ownerId));
      expect(emails).not.toContain(email(otherOwnerId));
    });

    it('will not update a user in another organization', async () => {
      const token = await tokenFor(ownerId);
      await request(app.getHttpServer())
        .patch(`/api/v1/users/${otherOwnerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Hijacked' })
        .expect(404);

      const { rows } = await pool.query<{ full_name: string }>(
        'SELECT full_name FROM users WHERE id = $1',
        [otherOwnerId],
      );
      expect(rows[0]?.full_name).not.toBe('Hijacked');
    });

    it('never returns a password hash', async () => {
      const token = await tokenFor(ownerId);
      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      expect(JSON.stringify(response.body)).not.toContain('password_hash');
    });
  });
});
