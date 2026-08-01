/**
 * Self-service password reset, end to end against real Postgres.
 *
 * The email itself is not asserted here: with no `EMAIL_API_KEY` the sender
 * reports SKIPPED and nothing leaves the process, and wiring a fake provider in
 * would test the fake. What IS asserted is everything the token is: that a
 * request mints exactly one, that the response never varies, that the link
 * works once, and that using it closes every other way into the account.
 *
 * Tokens are planted directly for the consuming cases, because the only place
 * the raw value ever exists is the email — which is the property that makes
 * the whole design safe, and would be a bug if the test could read it out of
 * the database instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. HTTP e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
process.env.REDIS_URL ??= 'redis://localhost:16379';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('POST /auth/forgot-password and /auth/reset-password', () => {
  let app: INestApplication;
  let pool: Pool;
  let hashResetToken: (token: string) => string;
  let generateResetToken: () => { token: string; tokenHash: string };

  const orgId = crypto.randomUUID();
  const orgSlug = `reset-${orgId.slice(0, 8)}`;
  const userId = crypto.randomUUID();
  const disabledUserId = crypto.randomUUID();

  const EMAIL = 'locked-out@e2e.test';
  const DISABLED_EMAIL = 'gone@e2e.test';
  const PASSWORD = 'the-password-they-forgot';
  const NEW_PASSWORD = 'a-brand-new-password-they-chose';

  /** Plant a live token and hand back the raw value, as the email would. */
  async function plantToken(
    options: { userId?: string; expiresAt?: Date; consumedAt?: Date | null } = {},
  ): Promise<string> {
    const { token, tokenHash } = generateResetToken();
    await pool.query(
      `INSERT INTO password_reset_tokens
         (id, organization_id, user_id, token_hash, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        orgId,
        options.userId ?? userId,
        tokenHash,
        options.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
        options.consumedAt ?? null,
      ],
    );
    return token;
  }

  /** The parts of an error body a caller could learn anything from. */
  function errorOf(body: unknown): { code?: unknown; message?: unknown } {
    const error = (body as { error?: { code?: unknown; message?: unknown } }).error ?? {};
    return { code: error.code, message: error.message };
  }

  function liveTokenCount(forUserId = userId): Promise<number> {
    return pool
      .query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM password_reset_tokens
          WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [forUserId],
      )
      .then((result) => Number(result.rows[0]?.count ?? 0));
  }

  beforeAll(async () => {
    const { AppModule } = await import('../../app.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { ScryptPasswordHasher } = await import('./domain/password-hasher');
    const resetDomain = await import('./domain/password-reset');

    hashResetToken = resetDomain.hashResetToken;
    generateResetToken = resetDomain.generateResetToken;

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
      'Reset Org',
      orgSlug,
    ]);

    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name, status)
       VALUES ($1, $2, $3, $4, 'Locked Out', 'ACTIVE'),
              ($5, $2, $6, $4, 'Departed', 'DISABLED')`,
      [userId, orgId, EMAIL, hash, disabledUserId, DISABLED_EMAIL],
    );

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
       VALUES ($1, $2, $3, NULL, 'OWNER')`,
      [crypto.randomUUID(), orgId, userId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM password_reset_tokens WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM refresh_tokens WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM memberships WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM users WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await app.close();
  });

  beforeEach(async () => {
    const { ScryptPasswordHasher } = await import('./domain/password-hasher');
    await pool.query('UPDATE users SET password_hash = $1 WHERE organization_id = $2', [
      await new ScryptPasswordHasher().hash(PASSWORD),
      orgId,
    ]);
    await pool.query('DELETE FROM password_reset_tokens WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM refresh_tokens WHERE organization_id = $1', [orgId]);
    // The audit assertions count entries, so a previous case's trail would
    // make them depend on execution order.
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]);
  });

  describe('requesting a link', () => {
    it('mints exactly one token for a real account', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ organizationSlug: orgSlug, email: EMAIL, locale: 'en' })
        .expect(202);

      expect(await liveTokenCount()).toBe(1);
    });

    it('answers an unknown address exactly as it answers a real one', async () => {
      const real = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ organizationSlug: orgSlug, email: EMAIL, locale: 'en' })
        .expect(202);

      const unknown = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ organizationSlug: orgSlug, email: 'nobody@e2e.test', locale: 'en' })
        .expect(202);

      // Byte-identical, because anything else is a user-enumeration oracle.
      expect(unknown.body).toEqual(real.body);
    });

    it('mints nothing for an unknown organization', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ organizationSlug: 'no-such-hotel', email: EMAIL, locale: 'en' })
        .expect(202);

      expect(await liveTokenCount()).toBe(0);
    });

    it('mints nothing for a disabled account', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ organizationSlug: orgSlug, email: DISABLED_EMAIL, locale: 'en' })
        .expect(202);

      expect(await liveTokenCount(disabledUserId)).toBe(0);
    });

    it('stops minting once the account has three live links', async () => {
      // Mailbox protection, not brute-force protection — see the domain module.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/forgot-password')
          .send({ organizationSlug: orgSlug, email: EMAIL, locale: 'en' })
          .expect(202);
      }

      expect(await liveTokenCount()).toBe(3);
    });

    it('mints nothing when there is nowhere for the link to point', async () => {
      // Production with no ADMIN_WEB_URL and no CORS origin. A link to
      // localhost would burn one of the three the throttle allows and look
      // like phishing when it arrived.
      const { ENV } = await import('../../config/env');
      const env = app.get<{ NODE_ENV: string; ADMIN_WEB_URL?: string; CORS_ORIGINS: string[] }>(
        ENV,
      );
      const restore = { node: env.NODE_ENV, admin: env.ADMIN_WEB_URL, cors: env.CORS_ORIGINS };
      Object.assign(env, {
        NODE_ENV: 'production',
        ADMIN_WEB_URL: undefined,
        CORS_ORIGINS: [],
      });

      try {
        await request(app.getHttpServer())
          .post('/api/v1/auth/forgot-password')
          .send({ organizationSlug: orgSlug, email: EMAIL, locale: 'en' })
          .expect(202);

        expect(await liveTokenCount()).toBe(0);
      } finally {
        Object.assign(env, {
          NODE_ENV: restore.node,
          ADMIN_WEB_URL: restore.admin,
          CORS_ORIGINS: restore.cors,
        });
      }
    });

    it('records the request in the audit trail without the token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ organizationSlug: orgSlug, email: EMAIL, locale: 'en' })
        .expect(202);

      const { rows } = await pool.query<{ after: unknown; actor_type: string }>(
        `SELECT after, actor_type FROM audit_logs
          WHERE action = 'auth.password_reset_requested' AND entity_id = $1`,
        [userId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_type).toBe('SYSTEM');

      // Not the token, and not its hash either: a hash in the trail is still a
      // verifier for anyone who intercepts the link.
      const { rows: tokenRows } = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
        [userId],
      );
      expect(JSON.stringify(rows[0]?.after)).not.toContain(tokenRows[0]?.token_hash);
    });
  });

  describe('using a link', () => {
    it('sets the new password and hands back the slug to sign in with', async () => {
      const token = await plantToken();

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      expect(response.body).toEqual({ organizationSlug: orgSlug, email: EMAIL });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: EMAIL, password: NEW_PASSWORD })
        .expect(200);
    });

    it('issues no session of its own', async () => {
      const token = await plantToken();

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      // A link in a mailbox must not become a logged-in browser.
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).not.toHaveProperty('accessToken');
    });

    it('stops the old password working', async () => {
      const token = await plantToken();

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: EMAIL, password: PASSWORD })
        .expect(401);
    });

    it('works exactly once', async () => {
      const token = await plantToken();

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'yet-another-password-entirely' })
        .expect(401);
    });

    it('kills every other link that was in flight', async () => {
      const first = await plantToken();
      const second = await plantToken();

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token: first, newPassword: NEW_PASSWORD })
        .expect(200);

      // Whoever asked for the earlier link must not be able to walk in after.
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token: second, newPassword: 'a-third-distinct-password' })
        .expect(401);
    });

    it('signs out every session the account had', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: EMAIL, password: PASSWORD })
        .expect(200);
      const cookie = login.headers['set-cookie'] as unknown as string[];

      const token = await plantToken();
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      // The reason for a reset is usually that somebody else holds the old
      // credential; a 30-day refresh token would hand the account back.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
    });

    it('refuses an expired link', async () => {
      const token = await plantToken({ expiresAt: new Date(Date.now() - 1000) });

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(401);
    });

    it('refuses a token nobody issued', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token: 'not-a-real-token', newPassword: NEW_PASSWORD })
        .expect(401);
    });

    it('says the same thing for an expired link as for an invented one', async () => {
      const expired = await plantToken({ expiresAt: new Date(Date.now() - 1000) });

      const a = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token: expired, newPassword: NEW_PASSWORD })
        .expect(401);

      const b = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token: 'invented', newPassword: NEW_PASSWORD })
        .expect(401);

      // Only the request id may differ — that is correlation, not information
      // about which token was which.
      expect(errorOf(a.body)).toEqual(errorOf(b.body));
    });

    it('refuses the password the account already has', async () => {
      const token = await plantToken();

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: PASSWORD })
        .expect(422);
    });

    it('leaves the link usable when the chosen password is refused', async () => {
      const token = await plantToken();

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'short' })
        .expect(422);

      // Burning the token on a validation error would lock out the person it
      // was issued to for a typo.
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);
    });

    it('refuses a link belonging to an account disabled since it was issued', async () => {
      const token = await plantToken({ userId: disabledUserId });

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(401);
    });

    it('records the completion in the audit trail', async () => {
      const token = await plantToken();

      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(200);

      const { rows } = await pool.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_logs
          WHERE action = 'auth.password_reset_completed' AND entity_id = $1`,
        [userId],
      );

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(rows[0])).not.toContain(hashResetToken(token));
    });
  });

  describe('a password change closes links in flight', () => {
    it('invalidates a live link when the owner changes their password', async () => {
      const token = await plantToken();

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: EMAIL, password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${(login.body as { accessToken: string }).accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);

      // Someone who suspects their password was seen changes it. If an attacker
      // had also requested a reset, that link must not undo the change later.
      await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'the-attackers-choice-of-password' })
        .expect(401);
    });
  });
});
