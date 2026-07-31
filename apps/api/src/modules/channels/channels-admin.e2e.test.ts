/**
 * Channel administration over HTTP.
 *
 * The connector framework and sync engine have existed since Phase 3 with no
 * way to create a channel except by hand-written SQL. The rules worth testing
 * are the two that prevent silent oversells: a channel cannot go live with an
 * unmapped room type, and credentials never come back out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Channel e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Channel administration', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'channel-admin-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `ch-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const suiteId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const foreignRoomTypeId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  let token = '';
  let readerToken = '';

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

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      orgId,
      orgSlug,
    ]);
    for (const [property, code] of [
      [propertyId, 'MAIN'],
      [otherPropertyId, 'SECOND'],
    ] as const) {
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
         VALUES ($1, $2, $3, 'Channel Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
        [property, orgId, code],
      );
    }

    for (const [roomType, property, code, name] of [
      [deluxeId, propertyId, 'DLX', 'Deluxe'],
      [suiteId, propertyId, 'STE', 'Suite'],
      [foreignRoomTypeId, otherPropertyId, 'DLX', 'Other Deluxe'],
    ] as const) {
      await pool.query(
        `INSERT INTO room_types (id, organization_id, property_id, code, name)
         VALUES ($1, $2, $3, $4, $5)`,
        [roomType, orgId, property, code, name],
      );
    }
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
      [deluxePlanId, orgId, propertyId, deluxeId],
    );

    for (const [id, email, role] of [
      [ownerId, `owner-${orgSlug}@e2e.test`, 'OWNER'],
      [readerId, `reader-${orgSlug}@e2e.test`, 'READ_ONLY'],
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

    token = await tokenFor(`owner-${orgSlug}@e2e.test`);
    readerToken = await tokenFor(`reader-${orgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'channel_reservations',
      'sync_jobs',
      'channel_rate_plan_mappings',
      'channel_room_type_mappings',
      'channels',
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
    for (const table of [
      'channel_reservations',
      'sync_jobs',
      'channel_rate_plan_mappings',
      'channel_room_type_mappings',
      'channels',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
  });

  async function tokenFor(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/v1/properties/${propertyId}/channels`;

  async function createChannel(body: Record<string, unknown> = {}): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(base())
      .set(auth())
      .send({ type: 'MOCK_OTA', name: 'Mock OTA', ...body })
      .expect(201);
    return response.body.id as string;
  }

  function mapEverything(channelId: string) {
    return request(app.getHttpServer())
      .put(`${base()}/${channelId}/mappings`)
      .set(auth())
      .send({
        roomTypes: [
          { localId: deluxeId, externalId: 'EXT-DLX', externalName: 'Deluxe Room' },
          { localId: suiteId, externalId: 'EXT-STE' },
        ],
        ratePlans: [{ localId: deluxePlanId, externalId: 'EXT-BAR' }],
      });
  }

  it('creates a channel INACTIVE, whatever the caller wanted', async () => {
    const channelId = await createChannel();
    const response = await request(app.getHttpServer())
      .get(`${base()}/${channelId}`)
      .set(auth())
      .expect(200);

    // A channel live on creation would push before a single room type was
    // mapped, which is exactly the silent-failure case.
    expect(response.body.status).toBe('INACTIVE');
    expect(response.body.totalRoomTypes).toBe(2);
    expect(response.body.mappedRoomTypes).toBe(0);
  });

  /**
   * THE rule. An active channel with one unmapped room type does not error —
   * the ARI push skips it, so the OTA keeps selling availability we never
   * update, and the first symptom is a guest arriving at a full hotel.
   */
  it('refuses to activate while a room type is unmapped', async () => {
    const channelId = await createChannel();
    await request(app.getHttpServer())
      .put(`${base()}/${channelId}/mappings`)
      .set(auth())
      // Deluxe only: the Suite is left unmapped.
      .send({
        roomTypes: [{ localId: deluxeId, externalId: 'EXT-DLX' }],
        ratePlans: [],
      })
      .expect(200);

    const refused = await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(auth())
      .send({ status: 'ACTIVE' })
      .expect(409);

    expect(refused.body.error.details.unmapped).toEqual(['Suite']);

    const stored = await request(app.getHttpServer())
      .get(`${base()}/${channelId}`)
      .set(auth())
      .expect(200);
    expect(stored.body.status).toBe('INACTIVE');
  });

  it('activates once every room type is mapped', async () => {
    const channelId = await createChannel();
    await mapEverything(channelId).expect(200);

    const response = await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(auth())
      .send({ status: 'ACTIVE' })
      .expect(200);

    expect(response.body.status).toBe('ACTIVE');
    expect(response.body.mappedRoomTypes).toBe(2);
    expect(response.body.mappedRatePlans).toBe(1);
  });

  /**
   * The column is write-only by design. Returning a decrypted secret to a
   * browser would undo the reason it is encrypted at rest.
   */
  it('never returns credentials, only whether any are stored', async () => {
    const channelId = await createChannel({
      credentials: { apiKey: 'super-secret-value', hotelId: '12345' },
    });

    const detail = await request(app.getHttpServer())
      .get(`${base()}/${channelId}`)
      .set(auth())
      .expect(200);

    expect(detail.body.hasCredentials).toBe(true);
    const serialised = JSON.stringify(detail.body);
    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain('apiKey');

    // Nor through the audit trail, which is readable by more people.
    const { rows } = await pool.query<{ after: unknown }>(
      `SELECT after FROM audit_logs WHERE entity_id = $1 AND action = 'channel.created'`,
      [channelId],
    );
    expect(JSON.stringify(rows[0]?.after)).not.toContain('super-secret-value');
  });

  it('stores credentials encrypted rather than as readable bytes', async () => {
    const channelId = await createChannel({ credentials: { apiKey: 'super-secret-value' } });
    const { rows } = await pool.query<{ credentials_encrypted: Buffer | null }>(
      'SELECT credentials_encrypted FROM channels WHERE id = $1',
      [channelId],
    );
    expect(rows[0]?.credentials_encrypted).not.toBeNull();
    expect(rows[0]?.credentials_encrypted?.toString('utf8')).not.toContain('super-secret-value');
  });

  it('replaces mappings wholesale rather than accumulating them', async () => {
    const channelId = await createChannel();
    await mapEverything(channelId).expect(200);

    const response = await request(app.getHttpServer())
      .put(`${base()}/${channelId}/mappings`)
      .set(auth())
      .send({
        roomTypes: [{ localId: deluxeId, externalId: 'EXT-DLX-RENAMED' }],
        ratePlans: [],
      })
      .expect(200);

    expect(response.body.roomTypeMappings).toHaveLength(1);
    expect(response.body.roomTypeMappings[0].externalId).toBe('EXT-DLX-RENAMED');
    expect(response.body.ratePlanMappings).toHaveLength(0);
  });

  it('refuses a mapping that points at another property', async () => {
    const channelId = await createChannel();
    await request(app.getHttpServer())
      .put(`${base()}/${channelId}/mappings`)
      .set(auth())
      .send({
        roomTypes: [{ localId: foreignRoomTypeId, externalId: 'EXT-FOREIGN' }],
        ratePlans: [],
      })
      .expect(422);
  });

  it('refuses a channel type no connector implements', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(auth())
      .send({ type: 'AGODA', name: 'Agoda' })
      .expect(422);
  });

  it('refuses ERROR as a status an operator can set', async () => {
    const channelId = await createChannel();
    await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(auth())
      .send({ status: 'ERROR' })
      .expect(422);
  });

  it('lets a reader see channels but not change them', async () => {
    const channelId = await createChannel();
    const readerAuth = { Authorization: `Bearer ${readerToken}` };

    await request(app.getHttpServer()).get(base()).set(readerAuth).expect(200);
    await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(readerAuth)
      .send({ name: 'Renamed' })
      .expect(403);
  });

  it('does not reach a channel through another property in the same org', async () => {
    const channelId = await createChannel();
    await request(app.getHttpServer())
      .get(`/api/v1/properties/${otherPropertyId}/channels/${channelId}`)
      .set(auth())
      .expect(404);
  });

  it('clears a stale error when the channel is deactivated', async () => {
    const channelId = await createChannel();
    await mapEverything(channelId).expect(200);
    await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(auth())
      .send({ status: 'ACTIVE' })
      .expect(200);
    await pool.query(`UPDATE channels SET last_error = 'push failed' WHERE id = $1`, [channelId]);

    const response = await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(auth())
      .send({ status: 'INACTIVE' })
      .expect(200);

    expect(response.body.lastError).toBeNull();
  });
});
