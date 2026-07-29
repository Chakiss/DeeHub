/**
 * HTTP end-to-end: real Express app, real middleware, real guards, real
 * PostgreSQL. Verifies the wire contract in api-spec.md, not just the domain.
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

describeIfDb('HTTP API', () => {
  let app: INestApplication;
  let pool: Pool;

  const orgId = crypto.randomUUID();
  const orgSlug = `e2e-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();

  const ownerId = crypto.randomUUID();
  const frontDeskId = crypto.randomUUID();
  const readOnlyId = crypto.randomUUID();
  const otherPropertyStaffId = crypto.randomUUID();

  const PASSWORD = 'correct-horse-battery-staple';
  const HORIZON = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];

  beforeAll(async () => {
    const { AppModule } = await import('../../app.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { ScryptPasswordHasher } = await import('./domain/password-hasher');

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
      'E2E Org',
      orgSlug,
    ]);

    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency,
                               tax_rate_bp, service_charge_rate_bp)
       VALUES ($1, $2, 'P1', 'E2E Property', 'Asia/Bangkok', 'THB', 700, 1000),
              ($3, $2, 'P2', 'Other Property', 'Asia/Bangkok', 'THB', 700, 1000)`,
      [propertyId, orgId, otherPropertyId],
    );

    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 2, 3, 2, 1)`,
      [roomTypeId, orgId, propertyId],
    );

    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available Rate')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );

    for (const [id, email, name] of [
      [ownerId, 'owner@e2e.test', 'Owner'],
      [frontDeskId, 'frontdesk@e2e.test', 'Front Desk'],
      [readOnlyId, 'readonly@e2e.test', 'Read Only'],
      [otherPropertyStaffId, 'other@e2e.test', 'Other Property Staff'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, orgId, email, hash, name],
      );
    }

    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role) VALUES
        ($1, $2, $3, NULL, 'OWNER'),
        ($4, $2, $5, $6, 'FRONT_DESK'),
        ($7, $2, $8, NULL, 'READ_ONLY'),
        ($9, $2, $10, $11, 'MANAGER')`,
      [
        crypto.randomUUID(),
        orgId,
        ownerId,
        crypto.randomUUID(),
        frontDeskId,
        propertyId,
        crypto.randomUUID(),
        readOnlyId,
        crypto.randomUUID(),
        otherPropertyStaffId,
        otherPropertyId,
      ],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_plans WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM room_types WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM memberships WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM refresh_tokens WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM users WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM properties WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await app.close();
  });

  async function seedInventory(allotment = 5): Promise<void> {
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    for (const date of HORIZON) {
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

  async function login(email: string): Promise<{ accessToken: string; cookie: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email, password: PASSWORD })
      .expect(200);

    const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
    return {
      accessToken: response.body.accessToken as string,
      cookie: cookies?.[0] ?? '',
    };
  }

  function bookingBody() {
    return {
      source: 'WALK_IN',
      booker: { name: 'Somchai Prasert', email: 's@example.com' },
      stays: [
        {
          roomTypeId,
          ratePlanId,
          checkIn: '2026-09-01',
          checkOut: '2026-09-03',
          adults: 2,
        },
      ],
    };
  }

  beforeEach(async () => {
    await seedInventory();
  });

  describe('POST /auth/login', () => {
    it('returns an access token, user and an httpOnly refresh cookie', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: 'owner@e2e.test', password: PASSWORD })
        .expect(200);

      expect(response.body.accessToken).toBeTypeOf('string');
      expect(response.body.expiresIn).toBe(900);
      expect(response.body.user.email).toBe('owner@e2e.test');
      expect(response.body.user.capabilities).toContain('reservation:create');
      // Never leak the hash.
      expect(JSON.stringify(response.body)).not.toContain('scrypt$');

      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies[0]).toContain('deehub_refresh=');
      expect(cookies[0]).toContain('HttpOnly');
    });

    it('rejects a wrong password with the same message as an unknown user', async () => {
      const wrongPassword = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: 'owner@e2e.test', password: 'nope' })
        .expect(401);

      const unknownUser = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: orgSlug, email: 'ghost@e2e.test', password: 'nope' })
        .expect(401);

      // Identical responses: no user enumeration.
      expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
      expect(wrongPassword.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects an unknown organization slug', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ organizationSlug: 'no-such-org', email: 'owner@e2e.test', password: PASSWORD })
        .expect(401);
    });

    it('rejects unknown fields rather than ignoring them', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          organizationSlug: orgSlug,
          email: 'owner@e2e.test',
          password: PASSWORD,
          organizationId: 'injected',
        })
        .expect(422);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new token pair and invalidates the old refresh token', async () => {
      const { cookie } = await login('owner@e2e.test');

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      expect(first.body.accessToken).toBeTypeOf('string');

      // Replaying the original cookie must fail: it was rotated.
      const replay = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
      expect(replay.body.error.message).toContain('already been used');
    });

    it('revokes the whole chain when a rotated token is reused', async () => {
      const { cookie } = await login('frontdesk@e2e.test');

      const rotated = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      const newCookie = (rotated.headers['set-cookie'] as unknown as string[])[0] ?? '';

      // Attacker replays the leaked original.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);

      // The victim's current token is now dead too — we cannot tell the copies
      // apart, so the safe move is to end every session.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', newCookie)
        .expect(401);
    });

    it('logs out idempotently', async () => {
      const { cookie } = await login('owner@e2e.test');
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
    });
  });

  describe('authentication is required by default', () => {
    it('rejects a missing token', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .send(bookingBody())
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      expect(response.body.error.requestId).toBeTypeOf('string');
    });

    it('rejects a garbage token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      // A structurally valid JWT with correct claims, signed by an attacker.
      // Only the signature distinguishes it from a real token.
      const { JwtService } = await import('@nestjs/jwt');
      const forged = await new JwtService().signAsync(
        { sub: ownerId, orgId, jti: 'forged' },
        { secret: 'attacker-secret-that-is-long-enough-to-sign', expiresIn: 900 },
      );
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('allows health checks without a token', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the current principal and capabilities', async () => {
      const { accessToken } = await login('frontdesk@e2e.test');
      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.email).toBe('frontdesk@e2e.test');
      expect(response.body.memberships).toHaveLength(1);
      expect(response.body.memberships[0].role).toBe('FRONT_DESK');
    });
  });

  describe('POST /properties/:propertyId/reservations', () => {
    it('creates a reservation and returns the full breakdown', async () => {
      const { accessToken } = await login('frontdesk@e2e.test');

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(bookingBody())
        .expect(201);

      expect(response.body.code).toMatch(/^DH-[A-Z0-9]{6}$/);
      expect(response.body.status).toBe('CONFIRMED');
      // 2 nights x 2,500 = 5,000; +10% service charge; +7% VAT on the sum.
      expect(response.body.subtotal).toEqual({ amount: 500000, currency: 'THB' });
      expect(response.body.serviceCharge).toEqual({ amount: 50000, currency: 'THB' });
      expect(response.body.tax).toEqual({ amount: 38500, currency: 'THB' });
      expect(response.body.total).toEqual({ amount: 588500, currency: 'THB' });
      expect(response.body.stays[0].nights).toHaveLength(2);
    });

    it('returns 409 INVENTORY_UNAVAILABLE when sold out', async () => {
      await seedInventory(1);
      const { accessToken } = await login('frontdesk@e2e.test');

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(bookingBody())
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(bookingBody())
        .expect(409);

      expect(response.body.error.code).toBe('INVENTORY_UNAVAILABLE');
      expect(response.body.error.details.unavailableDates).toEqual(['2026-09-01', '2026-09-02']);
    });

    it('rejects an impossible calendar date', async () => {
      const { accessToken } = await login('frontdesk@e2e.test');
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          ...bookingBody(),
          stays: [
            { roomTypeId, ratePlanId, checkIn: '2026-02-30', checkOut: '2026-03-02', adults: 2 },
          ],
        })
        .expect(422);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed date format at the edge', async () => {
      const { accessToken } = await login('frontdesk@e2e.test');
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          ...bookingBody(),
          stays: [
            { roomTypeId, ratePlanId, checkIn: '01/09/2026', checkOut: '2026-09-03', adults: 2 },
          ],
        })
        .expect(422);
    });

    it('rejects a zero-night stay', async () => {
      const { accessToken } = await login('frontdesk@e2e.test');
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          ...bookingBody(),
          stays: [
            { roomTypeId, ratePlanId, checkIn: '2026-09-01', checkOut: '2026-09-01', adults: 2 },
          ],
        })
        .expect(422);
    });
  });

  describe('authorization', () => {
    it('forbids a READ_ONLY user from creating a reservation', async () => {
      const { accessToken } = await login('readonly@e2e.test');
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(bookingBody())
        .expect(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.details.capability).toBe('reservation:create');
    });

    it('lets a READ_ONLY user read', async () => {
      const owner = await login('owner@e2e.test');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(bookingBody())
        .expect(201);

      const reader = await login('readonly@e2e.test');
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations/${created.body.id as string}`)
        .set('Authorization', `Bearer ${reader.accessToken}`)
        .expect(200);
    });

    it('hides a property the user has no membership for, as 404 not 403', async () => {
      // This manager belongs to otherProperty only. Revealing 403 would confirm
      // the property exists.
      const { accessToken } = await login('other@e2e.test');
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(bookingBody())
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('reservation lifecycle over HTTP', () => {
    it('creates, reads, cancels and frees the room', async () => {
      await seedInventory(1);
      const { accessToken } = await login('owner@e2e.test');
      const auth = { Authorization: `Bearer ${accessToken}` };

      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth)
        .send(bookingBody())
        .expect(201);

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations/${created.body.id as string}`)
        .set(auth)
        .expect(200);
      expect(fetched.body.version).toBe(0);
      expect(fetched.body.status).toBe('CONFIRMED');

      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${created.body.id as string}/cancel`)
        .set(auth)
        .send({ version: 0, reason: 'Guest changed plans' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.releasedNights).toEqual(['2026-09-01', '2026-09-02']);

      // The room is sellable again.
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth)
        .send(bookingBody())
        .expect(201);
    });

    it('returns 409 VERSION_MISMATCH on a stale cancel', async () => {
      const { accessToken } = await login('owner@e2e.test');
      const auth = { Authorization: `Bearer ${accessToken}` };

      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth)
        .send(bookingBody())
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${created.body.id as string}/cancel`)
        .set(auth)
        .send({ version: 99 })
        .expect(409);
      expect(response.body.error.code).toBe('VERSION_MISMATCH');
    });

    it('does not leak a reservation through another property URL', async () => {
      const { accessToken } = await login('owner@e2e.test');
      const auth = { Authorization: `Bearer ${accessToken}` };

      const created = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations`)
        .set(auth)
        .send(bookingBody())
        .expect(201);

      // Same organization, valid id, wrong property in the path.
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${otherPropertyId}/reservations/${created.body.id as string}`)
        .set(auth)
        .expect(404);
    });

    it('returns 404 for an unknown reservation id', async () => {
      const { accessToken } = await login('owner@e2e.test');
      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/reservations/${crypto.randomUUID()}`)
        .set(`Authorization`, `Bearer ${accessToken}`)
        .expect(404);
    });
  });
});
