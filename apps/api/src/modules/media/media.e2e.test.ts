/**
 * Photo HTTP contract against real PostgreSQL, with the object store faked.
 *
 * The store is a port, so the fake stands in for MinIO and GCS alike; what
 * is under test is the two-step protocol around it — a grant is not a row,
 * a row is only written for an object that exists, keys are minted by the
 * server, and deleting removes both halves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';
import type { ObjectStore, StoredObject, UploadGrant } from './domain/object-store';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Media e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/** An in-memory bucket. `put` is what the browser's PUT would have done. */
class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly grants: string[] = [];
  readonly deleted: string[] = [];

  isConfigured(): boolean {
    return true;
  }

  async createUploadGrant(key: string, contentType: string, bytes: number): Promise<UploadGrant> {
    this.grants.push(key);
    return {
      url: `https://fake-bucket.test/${key}?signed`,
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes) },
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }

  publicUrl(key: string): string {
    return `https://fake-bucket.test/${key}`;
  }

  put(key: string, contentType: string, bytes: number): void {
    this.objects.set(key, { contentType, bytes });
  }
}

describeIfDb('Media API', () => {
  let app: INestApplication;
  let pool: Pool;
  const store = new FakeObjectStore();

  const PASSWORD = 'media-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `md-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `mdx-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();
  const otherRoomTypeId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

  beforeAll(async () => {
    const { AppModule } = await import('../../app.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { ScryptPasswordHasher } = await import('../auth/domain/password-hasher');
    const { OBJECT_STORE } = await import('./domain/object-store');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OBJECT_STORE)
      .useValue(store)
      .compile();
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
      await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [org]);
      await pool.query('DELETE FROM media WHERE organization_id = $1', [org]);
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
  const base = () => `/api/v1/properties/${propertyId}/media`;

  async function upload(
    token: string,
    gallery: { kind: 'PROPERTY' | 'ROOM_TYPE'; roomTypeId?: string | null },
    contentType = 'image/jpeg',
    bytes = 120_000,
  ): Promise<{ mediaId: string; key: string }> {
    const grant = await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...gallery, contentType, bytes })
      .expect(201);
    const key = store.grants[store.grants.length - 1] as string;
    return { mediaId: grant.body.mediaId as string, key };
  }

  it('signs an upload with a server-minted key under the tenant prefix, and writes no row', async () => {
    const token = await managerToken();
    const grant = await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'PROPERTY', contentType: 'image/jpeg', bytes: 250_000 })
      .expect(201);

    expect(grant.body.uploadUrl).toMatch(/^https:\/\/fake-bucket\.test\/public\//);
    expect(grant.body.headers['Content-Type']).toBe('image/jpeg');
    expect(grant.body.headers['Content-Length']).toBe('250000');
    const key = store.grants[store.grants.length - 1] as string;
    expect(key.startsWith(`public/${orgId}/${propertyId}/`)).toBe(true);
    expect(key.endsWith('.jpg')).toBe(true);

    const rows = await pool.query('SELECT count(*)::int AS n FROM media WHERE property_id = $1', [
      propertyId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('refuses a type that is not an image and a size over the cap', async () => {
    const token = await managerToken();
    await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'PROPERTY', contentType: 'application/pdf', bytes: 1000 })
      .expect(422);
    await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'PROPERTY', contentType: 'image/jpeg', bytes: 6 * 1024 * 1024 })
      .expect(422);
  });

  it('attaches only after the object exists, then lists it with a public URL', async () => {
    const token = await managerToken();
    const { mediaId, key } = await upload(token, { kind: 'PROPERTY' });

    // Nothing was PUT yet: the row must not be written.
    const early = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'PROPERTY', mediaId })
      .expect(422);
    expect(early.body.error.message).toMatch(/not uploaded/i);

    store.put(key, 'image/jpeg', 120_000);
    const attached = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'PROPERTY', mediaId, width: 1600, height: 1200, alt: 'Pool at dusk' })
      .expect(201);
    expect(attached.body.id).toBe(mediaId);
    expect(attached.body.url).toBe(`https://fake-bucket.test/${key}`);
    expect(attached.body.sortOrder).toBe(0);

    const listing = await request(app.getHttpServer())
      .get(base())
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listing.body.storageAvailable).toBe(true);
    expect(listing.body.items.map((item: { id: string }) => item.id)).toContain(mediaId);
  });

  it('keeps room photos on a room type of the same property', async () => {
    const token = await managerToken();
    const { mediaId, key } = await upload(token, { kind: 'ROOM_TYPE', roomTypeId });
    store.put(key, 'image/jpeg', 120_000);
    const attached = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'ROOM_TYPE', roomTypeId, mediaId })
      .expect(201);
    expect(attached.body.roomTypeId).toBe(roomTypeId);

    // Another tenant's room type, even with the right id, is not this property's.
    await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'ROOM_TYPE',
        roomTypeId: otherRoomTypeId,
        contentType: 'image/jpeg',
        bytes: 10,
      })
      .expect(404);
  });

  it('reorders and deletes, removing the object too', async () => {
    const token = await managerToken();
    const first = await upload(token, { kind: 'PROPERTY' }, 'image/png', 5000);
    store.put(first.key, 'image/png', 5000);
    const row = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'PROPERTY', mediaId: first.mediaId })
      .expect(201);
    expect(row.body.sortOrder).toBeGreaterThan(0);

    const moved = await request(app.getHttpServer())
      .patch(`${base()}/${first.mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sortOrder: 0, alt: 'Lobby' })
      .expect(200);
    expect(moved.body.sortOrder).toBe(0);
    expect(moved.body.alt).toBe('Lobby');

    await request(app.getHttpServer())
      .delete(`${base()}/${first.mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(store.deleted).toContain(first.key);
    await request(app.getHttpServer())
      .delete(`${base()}/${first.mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('forbids a READ_ONLY user from uploading and another tenant from seeing anything', async () => {
    const reader = await tokenFor(`reader-${orgSlug}@e2e.test`, orgSlug);
    await request(app.getHttpServer())
      .get(base())
      .set('Authorization', `Bearer ${reader}`)
      .expect(200);
    const forbidden = await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${reader}`)
      .send({ kind: 'PROPERTY', contentType: 'image/jpeg', bytes: 10 })
      .expect(403);
    expect(forbidden.body.error.details.capability).toBe('property:update');

    const stranger = await tokenFor(`manager-${otherOrgSlug}@e2e.test`, otherOrgSlug);
    const listing = await request(app.getHttpServer())
      .get(base())
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    expect(listing.body.items).toEqual([]);
    await request(app.getHttpServer())
      .post(`${base()}/uploads`)
      .set('Authorization', `Bearer ${stranger}`)
      .send({ kind: 'PROPERTY', contentType: 'image/jpeg', bytes: 10 })
      .expect(404);
  });
});
