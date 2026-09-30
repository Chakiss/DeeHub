/**
 * Cancelling with a refund, against real PostgreSQL: the quote (from the frozen
 * policy and what was PAID), the desk's override and the refund posted to the
 * folio in the same transaction as the cancellation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. Cancel refund e2e tests must run against Postgres.',
  );
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

// Far enough ahead that a 24h notice is comfortably in time.
const FUTURE = ['2031-09-01', '2031-09-02', '2031-09-03'] as const;

describeIfDb('Cancel with a refund', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'cancel-refund-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `cr-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  let token = '';
  let readerToken = '';
  let pastNights: [string, string, string] = ['', '', ''];

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

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
      orgId,
      orgSlug,
    ]);
    for (const [id, code] of [
      [propertyId, 'MAIN'],
      [otherPropertyId, 'ANNEX'],
    ] as const) {
      // No tax or service charge, so the booking total is exactly the nights.
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                                 tax_rate_bp, service_charge_rate_bp)
         VALUES ($1, $2, $3, 'Refund Hotel', 'Asia/Bangkok', 'THB', 'TH', 0, 0)`,
        [id, orgId, code],
      );
    }
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 2, 4, 3, 2)`,
      [deluxeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name,
                               cancellation_notice_hours, cancellation_refund_percent)
       VALUES ($1, $2, $3, $4, 'BAR-DLX', 'Best Available', 24, 50)`,
      [planId, orgId, propertyId, deluxeId],
    );

    // Three nights that began a few days ago: a 24h notice on those is long gone.
    const { rows } = await pool.query<{ a: string; b: string; c: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - 5, 'YYYY-MM-DD') AS a,
              to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - 4, 'YYYY-MM-DD') AS b,
              to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - 3, 'YYYY-MM-DD') AS c`,
    );
    pastNights = [rows[0]!.a, rows[0]!.b, rows[0]!.c];

    const hash = await new ScryptPasswordHasher().hash(PASSWORD);
    for (const [id, email, role] of [
      [managerId, `manager-${orgSlug}@e2e.test`, 'MANAGER'],
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

    token = await tokenFor(`manager-${orgSlug}@e2e.test`);
    readerToken = await tokenFor(`reader-${orgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'folio_payments',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
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
  });

  beforeEach(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'folio_payments',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'rate_days',
      'inventory_days',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    for (const date of [...FUTURE, ...pastNights]) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 5)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 45000, 'THB')`,
          [orgId, propertyId, planId, date, occupancy],
        );
      }
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
  const base = (id: string) => `/api/v1/properties/${propertyId}/reservations/${id}`;

  /** Two nights at ฿450 = ฿900 total (no tax). */
  async function book(nights: readonly string[] = FUTURE): Promise<{ id: string; code: string }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'DIRECT',
        status: 'CONFIRMED',
        booker: { name: 'Krissada Laohongkiat', email: 'krissada@example.com' },
        stays: [
          {
            roomTypeId: deluxeId,
            ratePlanId: planId,
            checkIn: nights[0],
            checkOut: nights[2],
            adults: 1,
          },
        ],
      })
      .expect(201);
    expect(response.body.total.amount).toBe(90000);
    return { id: response.body.id as string, code: response.body.code as string };
  }

  async function pay(id: string, amount: number, method = 'PROMPTPAY') {
    await request(app.getHttpServer())
      .post(`${base(id)}/folio/payments`)
      .set(auth())
      .send({ kind: 'PAYMENT', method, amount })
      .expect(201);
  }

  const quote = (id: string) =>
    request(app.getHttpServer())
      .get(`${base(id)}/cancel-quote`)
      .set(auth());

  async function version(id: string): Promise<number> {
    const detail = await request(app.getHttpServer()).get(base(id)).set(auth()).expect(200);
    return detail.body.version as number;
  }

  async function cancel(id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`${base(id)}/cancel`)
      .set(auth())
      .send({ version: await version(id), ...body });
  }

  async function state(id: string) {
    const status = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [id],
    );
    const payments = await pool.query<{
      kind: string;
      method: string;
      amount_minor: number;
      reference: string | null;
    }>(
      `SELECT kind, method, amount_minor::int, reference FROM folio_payments
        WHERE reservation_id = $1 ORDER BY recorded_at`,
      [id],
    );
    return { status: status.rows[0]!.status, payments: payments.rows };
  }

  describe('the quote', () => {
    it('is the policy percentage of the total when fully paid and in time', async () => {
      const { id } = await book();
      await pay(id, 90000);
      const response = await quote(id).expect(200);
      expect(response.body).toMatchObject({
        policy: { noticeHours: 24, refundPercent: 50, inTime: true },
        totalMinor: 90000,
        paidMinor: 90000,
        refundedMinor: 0,
        suggestedRefundMinor: 45000,
        suggestedMethod: 'PROMPTPAY',
        currency: 'THB',
      });
      expect(typeof response.body.policy.deadline).toBe('string');
    });

    it('is capped by what was paid, not by the total', async () => {
      const { id } = await book();
      await pay(id, 30000);
      expect((await quote(id).expect(200)).body.suggestedRefundMinor).toBe(30000);
    });

    it('takes the method of the largest live payment', async () => {
      const { id } = await book();
      await pay(id, 10000, 'CASH');
      await pay(id, 50000, 'BANK_TRANSFER');
      await pay(id, 20000, 'CARD');
      expect((await quote(id).expect(200)).body.suggestedMethod).toBe('BANK_TRANSFER');
    });

    it('is 0 after the deadline, and reports it', async () => {
      const { id } = await book(pastNights);
      await pay(id, 90000);
      const response = await quote(id).expect(200);
      expect(response.body.policy.inTime).toBe(false);
      expect(response.body.suggestedRefundMinor).toBe(0);
    });

    it('has no policy for a booking with none of ours', async () => {
      const { id } = await book();
      await pay(id, 90000);
      await pool.query(
        `UPDATE reservation_stays SET cancellation_notice_hours = NULL,
                cancellation_refund_percent = NULL WHERE reservation_id = $1`,
        [id],
      );
      const response = await quote(id).expect(200);
      expect(response.body.policy).toBeNull();
      expect(response.body.suggestedRefundMinor).toBe(0);
    });

    it('is refused with 409 once the booking is cancelled', async () => {
      const { id } = await book();
      await cancel(id, {}).then((r) => expect(r.status).toBe(200));
      const response = await quote(id).expect(409);
      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('cancelling with a refund', () => {
    it('posts the suggested refund and cancels in one go', async () => {
      const { id, code } = await book();
      await pay(id, 90000);
      const response = await cancel(id, {
        refund: { amountMinor: 45000, method: 'PROMPTPAY' },
      }).then((r) => {
        expect(r.status).toBe(200);
        return r;
      });
      expect(response.body.status).toBe('CANCELLED');
      expect(response.body.refund).toMatchObject({ amountMinor: 45000, method: 'PROMPTPAY' });
      expect(typeof response.body.refund.paymentId).toBe('string');

      const after = await state(id);
      expect(after.status).toBe('CANCELLED');
      expect(after.payments).toContainEqual({
        kind: 'REFUND',
        method: 'PROMPTPAY',
        amount_minor: 45000,
        reference: `cancel:${code}`,
      });
    });

    it('refuses a different amount without a note, and changes nothing', async () => {
      const { id } = await book();
      await pay(id, 90000);
      const response = await cancel(id, { refund: { amountMinor: 60000, method: 'CASH' } });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('REFUND_NOTE_REQUIRED');

      const after = await state(id);
      expect(after.status).toBe('CONFIRMED');
      expect(after.payments.map((p) => p.kind)).toEqual(['PAYMENT']);
    });

    it('accepts a different amount with a note and audits both figures', async () => {
      const { id } = await book();
      await pay(id, 90000);
      const response = await cancel(id, {
        refund: { amountMinor: 60000, method: 'CASH', note: 'Guest was ill, manager approved' },
      });
      expect(response.status).toBe(200);
      expect(response.body.refund.amountMinor).toBe(60000);

      const { rows } = await pool.query<{ after: { refund: Record<string, unknown> } }>(
        `SELECT "after" FROM audit_logs
          WHERE organization_id = $1 AND entity_id = $2 AND action = 'reservation.cancelled'`,
        [orgId, id],
      );
      expect(rows[0]!.after.refund).toEqual({
        quotedRefundMinor: 45000,
        refundMinor: 60000,
        method: 'CASH',
        note: 'Guest was ill, manager approved',
      });
    });

    it('records a chosen 0 in the audit without a folio row', async () => {
      const { id } = await book();
      await pay(id, 90000);
      const response = await cancel(id, {
        refund: { amountMinor: 0, method: 'PROMPTPAY', note: 'Guest waived the refund' },
      });
      expect(response.status).toBe(200);
      expect(response.body.refund).toBeNull();

      const after = await state(id);
      expect(after.status).toBe('CANCELLED');
      expect(after.payments.map((p) => p.kind)).toEqual(['PAYMENT']);

      const { rows } = await pool.query<{ after: { refund: Record<string, unknown> } }>(
        `SELECT "after" FROM audit_logs
          WHERE organization_id = $1 AND entity_id = $2 AND action = 'reservation.cancelled'`,
        [orgId, id],
      );
      expect(rows[0]!.after.refund).toMatchObject({ quotedRefundMinor: 45000, refundMinor: 0 });
    });

    it('rolls the refund back when the cancel itself fails afterwards (stale version)', async () => {
      const { id } = await book();
      await pay(id, 90000);
      // The refund is valid; the version check fails AFTER the REFUND insert,
      // so this only passes while the refund is posted inside the transaction.
      const response = await request(app.getHttpServer())
        .post(`${base(id)}/cancel`)
        .set(auth())
        .send({ version: 99, refund: { amountMinor: 45000, method: 'PROMPTPAY' } });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_MISMATCH');

      const after = await state(id);
      expect(after.status).toBe('CONFIRMED');
      expect(after.payments.map((p) => p.kind)).toEqual(['PAYMENT']);
    });

    it('lets only one of two concurrent full refunds through', async () => {
      const { id } = await book();
      await pay(id, 90000);
      const refund = () =>
        request(app.getHttpServer())
          .post(`${base(id)}/folio/payments`)
          .set(auth())
          .send({ kind: 'REFUND', method: 'CASH', amount: 90000 });
      const results = await Promise.all([refund(), refund()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);

      const after = await state(id);
      const refunded = after.payments
        .filter((p) => p.kind === 'REFUND')
        .reduce((sum, p) => sum + p.amount_minor, 0);
      expect(refunded).toBe(90000);
    });

    it('rejects a refund above what was paid, and changes nothing', async () => {
      const { id } = await book();
      await pay(id, 30000);
      const response = await cancel(id, {
        refund: { amountMinor: 40000, method: 'CASH', note: 'Goodwill' },
      });
      expect(response.status).toBe(422);

      const after = await state(id);
      expect(after.status).toBe('CONFIRMED');
      expect(after.payments.map((p) => p.kind)).toEqual(['PAYMENT']);
    });

    it('still cancels with no refund block, as before', async () => {
      const { id } = await book();
      const response = await cancel(id, {});
      expect(response.status).toBe(200);
      expect(response.body.refund).toBeNull();
    });
  });

  describe('tenant boundary', () => {
    it("refuses a booking of another property through this property's path, changing nothing", async () => {
      const { id } = await book();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/properties/${otherPropertyId}/reservations/${id}/cancel`)
        .set(auth())
        .send({ version: await version(id) })
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect((await state(id)).status).toBe('CONFIRMED');
    });
  });

  describe('access', () => {
    it('gives a read-only token 403 on both routes', async () => {
      const { id } = await book();
      const readerAuth = { Authorization: `Bearer ${readerToken}` };
      await request(app.getHttpServer())
        .get(`${base(id)}/cancel-quote`)
        .set(readerAuth)
        .expect(403);
      await request(app.getHttpServer())
        .post(`${base(id)}/cancel`)
        .set(readerAuth)
        .send({ version: 0 })
        .expect(403);
    });

    it("answers 404 through another property's path", async () => {
      const { id } = await book();
      const other = `/api/v1/properties/${otherPropertyId}/reservations/${id}`;
      await request(app.getHttpServer()).get(`${other}/cancel-quote`).set(auth()).expect(404);
      await request(app.getHttpServer())
        .post(`${other}/cancel`)
        .set(auth())
        .send({ version: 1, refund: { amountMinor: 0, method: 'CASH' } })
        .expect(404);
    });
  });
});
