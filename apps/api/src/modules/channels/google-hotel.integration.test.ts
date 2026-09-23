/**
 * Google Hotels, end to end inside this process: a property with a Google
 * channel, a fake Hotel Center on a local port, and the two paths a price
 * takes to it — a forced sync, and a change recorded for the maintenance
 * job to push because there is no Redis. Plus the feed Google fetches and
 * the id → address lookup its landing link uses.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Google Hotel tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
// No Redis: the relay must record what it owes instead of enqueueing.
delete process.env.REDIS_URL;
process.env.GOOGLE_HOTEL_PARTNER_KEY = 'deehub-test';
process.env.GOOGLE_HOTEL_FEED_KEY = 'feed-key-for-tests';

const describeIfDb = connectionString ? describe : describe.skip;

/** A Hotel Center that records what it is sent and answers like Google. */
class FakeGoogle {
  readonly uploads: { path: string; body: string }[] = [];
  refuse: 'none' | '403' | 'error' = 'none';
  private server: Server | null = null;

  async listen(): Promise<number> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        this.uploads.push({ path: req.url ?? '', body });
        if (this.refuse === '403') {
          res.writeHead(403).end('Forbidden');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          this.refuse === 'error'
            ? '<Response><Errors><Error code="1">Unknown hotel</Error></Errors></Response>'
            : '<Response><Success/></Response>',
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const DATES = [0, 1, 2].map((offset) =>
  new Date(Date.now() + (50 + offset) * 86_400_000).toISOString().slice(0, 10),
);

describeIfDb('Google Hotels channel', () => {
  let app: INestApplication;
  let pool: Pool;
  const google = new FakeGoogle();

  const orgId = crypto.randomUUID();
  const orgSlug = `gh-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const deskPlanId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const PASSWORD = 'google-hotel-e2e-password';
  let token = '';
  let channelId = '';

  beforeAll(async () => {
    const port = await google.listen();
    process.env.GOOGLE_HOTEL_UPLOAD_URL = `http://127.0.0.1:${String(port)}`;

    const { AppModule } = await import('../../app.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { ScryptPasswordHasher } = await import('../auth/domain/password-hasher');

    const { OutboxModule } = await import('../outbox/outbox.module');
    // The relay lives in the worker's module graph; pulled in here so the
    // no-Redis path can be driven by hand.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, OutboxModule],
    }).compile();
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
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                               tax_rate_bp, service_charge_rate_bp, prices_include_tax,
                               address_line1, city, postal_code, latitude, longitude, phone)
       VALUES ($1, $2, 'MAIN', 'Google Test Resort', 'Asia/Bangkok', 'THB', 'TH', 700, 1000, false,
               '60/11 Huai Yai', 'Bang Lamung', '20150', 12.9236, 100.8825, '063 548 5456')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name, standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'BUN', 'Standard Bungalow', 2, 2, 2, 0)`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name, sell_online, is_refundable)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available', true, true),
              ($5, $2, $3, $4, 'DESK', 'Walk-in', false, false)`,
      [planId, orgId, propertyId, roomTypeId, deskPlanId],
    );
    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 3, 0)`,
        [orgId, propertyId, roomTypeId, date],
      );
      for (const [plan, amount] of [
        [planId, 100000],
        [deskPlanId, 50000],
      ] as const) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, 2, $5, 'THB')`,
          [orgId, propertyId, plan, date, amount],
        );
      }
    }
    const hash = await new ScryptPasswordHasher().hash(PASSWORD);
    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4, $3)`,
      [userId, orgId, `owner-${orgSlug}@e2e.test`, hash],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role) VALUES ($1, $2, $3, NULL, 'OWNER')`,
      [crypto.randomUUID(), orgId, userId],
    );
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email: `owner-${orgSlug}@e2e.test`, password: PASSWORD })
      .expect(200);
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'ari_sync_requests',
      'sync_jobs',
      'channel_rate_plan_mappings',
      'channel_room_type_mappings',
      'channels',
      'rate_days',
      'inventory_days',
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
    await google.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/v1/properties/${propertyId}/channels`;

  it('creates a Google channel with no credentials and maps it in one click', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth())
      .send({ type: 'GOOGLE_HOTEL', name: 'Google Hotels' })
      .expect(201);
    channelId = created.body.id as string;

    const mapped = await request(app.getHttpServer())
      .post(`${base()}/${channelId}/auto-map`)
      .set(auth());
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    // The desk-only plan is not mapped: Google must never see it.
    expect(mapped.body).toEqual({ roomTypes: 1, ratePlans: 1 });
    const rows = await pool.query(
      'SELECT external_rate_id FROM channel_rate_plan_mappings WHERE channel_id = $1',
      [channelId],
    );
    expect(rows.rows.map((row) => row.external_rate_id)).toEqual(['BAR']);
  });

  it('describes the rooms and packages to Google when activated', async () => {
    await request(app.getHttpServer())
      .patch(`${base()}/${channelId}`)
      .set(auth())
      .send({ status: 'ACTIVE' })
      .expect(200);
    const upload = google.uploads.find((entry) => entry.path === '/property_data');
    expect(upload).toBeDefined();
    expect(upload!.body).toContain(`<Property>${propertyId}</Property>`);
    expect(upload!.body).toContain('partner="deehub-test"');
    expect(upload!.body).toContain('<RoomID>BUN</RoomID>');
    expect(upload!.body).toContain('<PackageID>BAR</PackageID>');
    expect(upload!.body).not.toContain('DESK');
  });

  it('pushes prices all-in, with the hotel id as HotelCode, on a forced sync', async () => {
    google.uploads.length = 0;
    const response = await request(app.getHttpServer())
      .post(`${base()}/${channelId}/sync`)
      .set(auth())
      .expect(200);
    expect(response.body.catalogError).toBeNull();
    expect(response.body.roomTypes[0].error).toBeNull();

    const rates = google.uploads.find((entry) => entry.path === '/ota/hotel_rate_amount_notif');
    expect(rates).toBeDefined();
    expect(rates!.body).toContain(`HotelCode="${propertyId}"`);
    // 1,000 net → 1,100 with service charge → 1,177 with VAT: the checkout's figure.
    expect(rates!.body).toContain('AmountBeforeTax="1000.00" AmountAfterTax="1177.00"');
    expect(rates!.body).toContain('RatePlanCode="BAR"');
    expect(rates!.body).not.toContain('DESK');
    expect(google.uploads.some((entry) => entry.path === '/ota/hotel_avail_notif')).toBe(true);
    const inventory = google.uploads.find((entry) => entry.path === '/ota/hotel_inv_count_notif');
    expect(inventory!.body).toContain('Count="3"');
  });

  it('records a change for the maintenance job when there is no Redis, then pushes it', async () => {
    google.uploads.length = 0;
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/inventory`)
      .set(auth())
      .send({ updates: [{ roomTypeId, from: DATES[0], to: DATES[1], stopSell: true }] })
      .expect(200);

    const { OutboxRelayService } = await import('../outbox/outbox-relay.service');
    const { DrainAriRequestsUseCase } = await import('./application/drain-ari-requests.usecase');
    await app.get(OutboxRelayService).drainOnce();

    const pending = await pool.query(
      `SELECT date_from::text, date_to::text FROM ari_sync_requests WHERE channel_id = $1 AND status = 'PENDING'`,
      [channelId],
    );
    expect(pending.rowCount).toBeGreaterThan(0);
    expect(google.uploads).toHaveLength(0);

    const drained = await app.get(DrainAriRequestsUseCase).execute();
    expect(drained).toMatchObject({ groups: 1, pushed: 1, failed: 0, abandoned: 0 });
    const avail = google.uploads.find((entry) => entry.path === '/ota/hotel_avail_notif');
    expect(avail!.body).toContain('Status="Close" Restriction="Master"');
    const left = await pool.query(
      `SELECT count(*)::int AS n FROM ari_sync_requests WHERE channel_id = $1 AND status = 'PENDING'`,
      [channelId],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('keeps a refused push pending with the reason, so nothing is silently lost', async () => {
    google.refuse = '403';
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/inventory`)
      .set(auth())
      .send({ updates: [{ roomTypeId, from: DATES[1], to: DATES[2], allotment: 4 }] })
      .expect(200);
    const { OutboxRelayService } = await import('../outbox/outbox-relay.service');
    const { DrainAriRequestsUseCase } = await import('./application/drain-ari-requests.usecase');
    await app.get(OutboxRelayService).drainOnce();
    const drained = await app.get(DrainAriRequestsUseCase).execute();
    expect(drained.failed).toBe(1);
    const row = await pool.query(
      `SELECT status, attempts, last_error FROM ari_sync_requests WHERE channel_id = $1 AND status = 'PENDING'`,
      [channelId],
    );
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].last_error).toMatch(/allow-list/);
    google.refuse = 'none';
    await app.get(DrainAriRequestsUseCase).execute();
  });

  it('tells the operator the address is not allow-listed when the test upload is refused', async () => {
    google.refuse = '403';
    const response = await request(app.getHttpServer())
      .post(`${base()}/${channelId}/test-connection`)
      .set(auth())
      .expect(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.detail).toMatch(/allow-list/);
    google.refuse = 'none';
  });

  it('serves the Hotel List Feed to the key, and nothing to anyone else', async () => {
    await request(app.getHttpServer()).get('/api/v1/public/google/hotel-list.xml').expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/public/google/hotel-list.xml?key=wrong')
      .expect(404);
    const feed = await request(app.getHttpServer()).get(
      '/api/v1/public/google/hotel-list.xml?key=feed-key-for-tests',
    );
    expect(feed.status, feed.text).toBe(200);
    expect(feed.headers['content-type']).toMatch(/application\/xml/);
    expect(feed.text).toContain(`<id>${propertyId}</id><name>Google Test Resort</name>`);
    expect(feed.text).toContain('<component name="postal_code">20150</component>');
    expect(feed.text).toContain('<latitude>12.9236</latitude>');
  });

  it('turns the hotel id into the booking address, and nothing into nothing', async () => {
    const found = await request(app.getHttpServer())
      .get(`/api/v1/public/resolve/${propertyId}`)
      .expect(200);
    expect(found.body).toEqual({ organizationSlug: orgSlug, propertyCode: 'MAIN' });
    await request(app.getHttpServer())
      .get(`/api/v1/public/resolve/${crypto.randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/api/v1/public/resolve/not-a-uuid').expect(404);
  });
});
