/**
 * The hotel's books, against real PostgreSQL.
 *
 * The arithmetic is covered by the `domain/*.test.ts` files. What these add is
 * everything the database and the guard decide: that a supplier invoice cannot
 * be entered twice, that a manager can record what the electricity cost without
 * being shown what the owner cleared, that a void cannot happen twice, and that
 * the profit figure agrees with the bookings it was derived from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Accounting e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/** Far future, so these stays never become "begun" while the suite runs. */
const MONTH_FROM = '2031-05-01';
const MONTH_TO = '2031-06-01';
const RATE_MINOR = 120_000;

describeIfDb('Accounting', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'accounting-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `ac-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const deskId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  /** A second organization, to prove tenant isolation is real. */
  const otherOrgId = crypto.randomUUID();
  const otherOrgSlug = `ax-${otherOrgId.slice(0, 8)}`;
  const otherPropertyId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

  let ownerToken = '';
  let managerToken = '';
  let deskToken = '';
  let readerToken = '';
  let otherToken = '';

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

    for (const [id, slug] of [
      [orgId, orgSlug],
      [otherOrgId, otherOrgSlug],
    ] as const) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)', [
        id,
        slug,
      ]);
    }

    for (const [id, org, code] of [
      [propertyId, orgId, 'MAIN'],
      [otherPropertyId, otherOrgId, 'OTHER'],
    ] as const) {
      await pool.query(
        `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                                 tax_rate_bp, service_charge_rate_bp)
         VALUES ($1, $2, $3, 'Accounting Hotel', 'Asia/Bangkok', 'THB', 'TH', 700, 1000)`,
        [id, org, code],
      );
    }

    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 2, 4, 3, 2)`,
      [deluxeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR-DLX', 'Best Available')`,
      [deluxePlanId, orgId, propertyId, deluxeId],
    );

    for (const [id, org, email, role] of [
      [ownerId, orgId, `owner-${orgSlug}@e2e.test`, 'OWNER'],
      [managerId, orgId, `manager-${orgSlug}@e2e.test`, 'MANAGER'],
      [deskId, orgId, `desk-${orgSlug}@e2e.test`, 'FRONT_DESK'],
      [readerId, orgId, `reader-${orgSlug}@e2e.test`, 'READ_ONLY'],
      [otherUserId, otherOrgId, `owner-${otherOrgSlug}@e2e.test`, 'OWNER'],
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

    ownerToken = await tokenFor(orgSlug, `owner-${orgSlug}@e2e.test`);
    managerToken = await tokenFor(orgSlug, `manager-${orgSlug}@e2e.test`);
    deskToken = await tokenFor(orgSlug, `desk-${orgSlug}@e2e.test`);
    readerToken = await tokenFor(orgSlug, `reader-${orgSlug}@e2e.test`);
    otherToken = await tokenFor(otherOrgSlug, `owner-${otherOrgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const org of [orgId, otherOrgId]) {
      for (const table of [
        'audit_logs',
        'outbox_events',
        'revenue_entries',
        'expense_recurrences',
        'expenses',
        'vendors',
        'expense_categories',
        'accounting_settings',
        'folio_payments',
        'folio_charges',
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
        await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
      }
      await pool.query('DELETE FROM organizations WHERE id = $1', [org]);
    }
    await app.close();
  });

  beforeEach(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'revenue_entries',
      'expense_recurrences',
      'expenses',
      'vendors',
      'expense_categories',
      'accounting_settings',
      'folio_payments',
      'folio_charges',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'rate_days',
      'inventory_days',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }

    for (let offset = 0; offset < 40; offset += 1) {
      const date = addDays(MONTH_FROM, offset - 5);
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 4)`,
        [orgId, propertyId, deluxeId, date],
      );
      await pool.query(
        `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy,
                                amount_minor, currency)
         VALUES ($1, $2, $3, $4, 2, $5, 'THB')`,
        [orgId, propertyId, deluxePlanId, date, RATE_MINOR],
      );
    }
  });

  async function tokenFor(slug: string, email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: slug, email, password: PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  }

  const asOwner = () => ({ Authorization: `Bearer ${ownerToken}` });
  const asManager = () => ({ Authorization: `Bearer ${managerToken}` });

  const base = `/api/v1/properties/${propertyId}/accounting`;

  async function categoryId(code: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`${base}/categories`)
      .set(asOwner())
      .expect(200);
    const found = response.body.items.find((item: { code: string }) => item.code === code);
    expect(found, `seeded category ${code}`).toBeDefined();
    return found.id as string;
  }

  /** Not async: callers chain `.expect()` on the supertest request itself. */
  function postExpense(body: Record<string, unknown>, headers = asOwner()) {
    return request(app.getHttpServer()).post(`${base}/expenses`).set(headers).send(body);
  }

  // ------------------------------------------------------------- categories

  describe('categories', () => {
    it('seeds Thai hotel defaults the first time they are asked for', async () => {
      const response = await request(app.getHttpServer())
        .get(`${base}/categories`)
        .set(asOwner())
        .expect(200);

      const codes = response.body.items.map((item: { code: string }) => item.code);
      expect(codes).toContain('ELECTRICITY');
      expect(codes).toContain('SALARY');
      expect(codes).toContain('OTA_COMMISSION');

      const electricity = response.body.items.find(
        (item: { code: string }) => item.code === 'ELECTRICITY',
      );
      expect(electricity.nameTh).toBe('ค่าไฟฟ้า');
    });

    it('does not seed a second set on the next request', async () => {
      const first = await request(app.getHttpServer())
        .get(`${base}/categories`)
        .set(asOwner())
        .expect(200);
      const second = await request(app.getHttpServer())
        .get(`${base}/categories`)
        .set(asOwner())
        .expect(200);

      expect(second.body.items).toHaveLength(first.body.items.length);
      const ids = second.body.items.map((item: { id: string }) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // --------------------------------------------------------------- expenses

  describe('recording an expense', () => {
    it('splits VAT out of the total on the receipt', async () => {
      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ vatRegistered: true, vatRegisteredFrom: '2020-01-01' })
        .expect(200);

      const response = await postExpense({
        categoryId: await categoryId('ELECTRICITY'),
        description: 'PEA July',
        amount: 107_000,
        amountIs: 'GROSS',
        expenseDate: '2031-05-10',
      }).expect(201);

      expect(response.body.net.amount).toBe(100_000);
      expect(response.body.vat.amount).toBe(7_000);
      expect(response.body.gross.amount).toBe(107_000);
      expect(response.body.paid.amount).toBe(107_000);
      // Claimed in the invoice's own month unless told otherwise.
      expect(response.body.vatClaimedPeriod).toBe('2031-05');
    });

    /**
     * A property that is not VAT registered cannot reclaim input tax, so the
     * whole amount stays in the cost where it belongs.
     */
    it('records no input VAT for a property that is not registered', async () => {
      const response = await postExpense({
        categoryId: await categoryId('ELECTRICITY'),
        description: 'PEA July',
        amount: 107_000,
        amountIs: 'GROSS',
        expenseDate: '2031-05-10',
      }).expect(201);

      expect(response.body.vat.amount).toBe(0);
      expect(response.body.net.amount).toBe(107_000);
      expect(response.body.vatClaimedPeriod).toBeNull();
    });

    it('withholds on the value of the service, not on the VAT charged on it', async () => {
      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ vatRegistered: true, vatRegisteredFrom: '2020-01-01' })
        .expect(200);

      const response = await postExpense({
        categoryId: await categoryId('RENT'),
        description: 'Ground rent, May',
        amount: 107_000,
        amountIs: 'GROSS',
        whtRateBp: 500,
        expenseDate: '2031-05-01',
      }).expect(201);

      // 5% of 1,000 = 50, not 5% of 1,070.
      expect(response.body.wht.amount).toBe(5_000);
      expect(response.body.paid.amount).toBe(102_000);
    });

    it('defaults the expense date to today in the property timezone', async () => {
      const { rows } = await pool.query<{ today: string }>(
        `SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`,
      );
      const response = await postExpense({
        categoryId: await categoryId('MISC'),
        description: 'Petty cash',
        amount: 5_000,
      }).expect(201);

      expect(response.body.expenseDate).toBe(rows[0]!.today);
    });

    it('refuses a paid date with no payment method', async () => {
      const response = await postExpense({
        categoryId: await categoryId('MISC'),
        description: 'Half-entered',
        amount: 5_000,
        expenseDate: '2031-05-02',
        paidDate: '2031-05-03',
      }).expect(422);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown category rather than writing an orphan row', async () => {
      await postExpense({
        categoryId: crypto.randomUUID(),
        description: 'Nowhere',
        amount: 1_000,
        expenseDate: '2031-05-02',
      }).expect(404);
    });
  });

  // ------------------------------------------------------- the duplicate guard

  describe('duplicate supplier invoices', () => {
    it('refuses the same invoice number twice for one vendor', async () => {
      const vendor = await request(app.getHttpServer())
        .post(`${base}/vendors`)
        .set(asOwner())
        .send({ name: 'การไฟฟ้าส่วนภูมิภาค', taxpayerType: 'JURISTIC' })
        .expect(201);

      const body = {
        categoryId: await categoryId('ELECTRICITY'),
        vendorId: vendor.body.id,
        description: 'PEA May',
        amount: 250_000,
        expenseDate: '2031-05-05',
        supplierDocNumber: 'INV-2031-0501',
      };

      await postExpense(body).expect(201);
      const second = await postExpense(body).expect(409);
      expect(second.body.error.details.code).toBe('DUPLICATE_SUPPLIER_DOCUMENT');
    });

    it('frees the number again once the wrong entry is voided', async () => {
      const vendor = await request(app.getHttpServer())
        .post(`${base}/vendors`)
        .set(asOwner())
        .send({ name: 'Somchai Plumbing' })
        .expect(201);

      const body = {
        categoryId: await categoryId('MAINTENANCE'),
        vendorId: vendor.body.id,
        description: 'Pipe repair',
        amount: 80_000,
        expenseDate: '2031-05-06',
        supplierDocNumber: 'A-77',
      };

      const first = await postExpense(body).expect(201);
      await postExpense(body).expect(409);

      await request(app.getHttpServer())
        .post(`${base}/expenses/${first.body.id}/void`)
        .set(asOwner())
        .send({ reason: 'Entered against the wrong vendor' })
        .expect(201);

      await postExpense(body).expect(201);
    });

    it('allows the same number for two different vendors', async () => {
      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`${base}/vendors`)
          .set(asOwner())
          .send({ name: 'Vendor A' })
          .expect(201),
        request(app.getHttpServer())
          .post(`${base}/vendors`)
          .set(asOwner())
          .send({ name: 'Vendor B' })
          .expect(201),
      ]);

      const category = await categoryId('OFFICE');
      for (const vendor of [a, b]) {
        await postExpense({
          categoryId: category,
          vendorId: vendor.body.id,
          description: 'Stationery',
          amount: 10_000,
          expenseDate: '2031-05-07',
          supplierDocNumber: '0001',
        }).expect(201);
      }
    });
  });

  // ------------------------------------------------------------------ voiding

  describe('voiding', () => {
    it('keeps the row, its reason and an audit entry', async () => {
      const created = await postExpense({
        categoryId: await categoryId('MISC'),
        description: 'Mis-keyed',
        amount: 999_999,
        expenseDate: '2031-05-08',
      }).expect(201);

      const voided = await request(app.getHttpServer())
        .post(`${base}/expenses/${created.body.id}/void`)
        .set(asOwner())
        .send({ reason: 'Typed 9,999.99 instead of 99.99' })
        .expect(201);

      expect(voided.body.voidedAt).not.toBeNull();
      expect(voided.body.voidedReason).toBe('Typed 9,999.99 instead of 99.99');

      const { rows } = await pool.query(
        `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`,
        [created.body.id],
      );
      expect(rows.map((row) => row.action)).toEqual(['expense.recorded', 'expense.voided']);
    });

    it('refuses to void the same expense twice', async () => {
      const created = await postExpense({
        categoryId: await categoryId('MISC'),
        description: 'Once only',
        amount: 1_000,
        expenseDate: '2031-05-09',
      }).expect(201);

      const void1 = request(app.getHttpServer())
        .post(`${base}/expenses/${created.body.id}/void`)
        .set(asOwner())
        .send({ reason: 'first' });
      await void1.expect(201);

      await request(app.getHttpServer())
        .post(`${base}/expenses/${created.body.id}/void`)
        .set(asOwner())
        .send({ reason: 'second' })
        .expect(409);
    });

    it('drops a voided expense out of the list and the totals', async () => {
      const category = await categoryId('CLEANING');
      const kept = await postExpense({
        categoryId: category,
        description: 'Kept',
        amount: 100_000,
        expenseDate: '2031-05-11',
      }).expect(201);
      const dropped = await postExpense({
        categoryId: category,
        description: 'Dropped',
        amount: 400_000,
        expenseDate: '2031-05-11',
      }).expect(201);

      await request(app.getHttpServer())
        .post(`${base}/expenses/${dropped.body.id}/void`)
        .set(asOwner())
        .send({ reason: 'duplicate' })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}`)
        .set(asOwner())
        .expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([kept.body.id]);

      const withVoided = await request(app.getHttpServer())
        .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}&includeVoided=true`)
        .set(asOwner())
        .expect(200);
      expect(withVoided.body.items).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------- cash/accrual

  describe('cash and accrual', () => {
    it('shows an unpaid bill on the accrual basis and not on the cash basis', async () => {
      await postExpense({
        categoryId: await categoryId('MAINTENANCE'),
        description: 'Invoiced, not yet paid',
        amount: 300_000,
        expenseDate: '2031-05-12',
      }).expect(201);

      const accrual = await request(app.getHttpServer())
        .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}&basis=ACCRUAL`)
        .set(asOwner())
        .expect(200);
      expect(accrual.body.items).toHaveLength(1);

      const cash = await request(app.getHttpServer())
        .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}&basis=CASH`)
        .set(asOwner())
        .expect(200);
      expect(cash.body.items).toHaveLength(0);
    });

    it('files a bill under the month it was invoiced and the month it was paid', async () => {
      await postExpense({
        categoryId: await categoryId('MAINTENANCE'),
        description: 'Invoiced May, paid June',
        amount: 200_000,
        expenseDate: '2031-05-30',
        paidDate: '2031-06-05',
        paymentMethod: 'BANK_TRANSFER',
      }).expect(201);

      const mayAccrual = await request(app.getHttpServer())
        .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}&basis=ACCRUAL`)
        .set(asOwner())
        .expect(200);
      expect(mayAccrual.body.items).toHaveLength(1);

      const mayCash = await request(app.getHttpServer())
        .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}&basis=CASH`)
        .set(asOwner())
        .expect(200);
      expect(mayCash.body.items).toHaveLength(0);

      const juneCash = await request(app.getHttpServer())
        .get(`${base}/expenses?from=2031-06-01&to=2031-07-01&basis=CASH`)
        .set(asOwner())
        .expect(200);
      expect(juneCash.body.items).toHaveLength(1);
    });
  });

  // ------------------------------------------------------- the VAT claim window

  describe('the input VAT claim window', () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ vatRegistered: true, vatRegisteredFrom: '2020-01-01' })
        .expect(200);
    });

    it('lets a late invoice be claimed in a later month', async () => {
      const response = await postExpense({
        categoryId: await categoryId('MAINTENANCE'),
        description: 'Found in the drawer in September',
        amount: 107_000,
        expenseDate: '2031-05-03',
        vatClaimedPeriod: '2031-09',
      }).expect(201);

      expect(response.body.vatClaimedPeriod).toBe('2031-09');
    });

    it('refuses a claim more than six months after the invoice', async () => {
      const response = await postExpense({
        categoryId: await categoryId('MAINTENANCE'),
        description: 'Too late',
        amount: 107_000,
        expenseDate: '2031-05-03',
        vatClaimedPeriod: '2031-12',
      }).expect(422);

      expect(response.body.error.details.code).toBe('VAT_CLAIM_WINDOW_EXPIRED');
    });

    it('refuses a claim before the invoice was issued', async () => {
      await postExpense({
        categoryId: await categoryId('MAINTENANCE'),
        description: 'Before it happened',
        amount: 107_000,
        expenseDate: '2031-05-03',
        vatClaimedPeriod: '2031-04',
      }).expect(422);
    });
  });

  // ---------------------------------------------------------------- reporting

  describe('the profit and loss', () => {
    it('counts the service charge as revenue and keeps VAT out of it', async () => {
      await book('2031-05-10', '2031-05-12');

      const response = await request(app.getHttpServer())
        .get(`${base}/reports/profit-loss?from=${MONTH_FROM}&to=${MONTH_TO}`)
        .set(asOwner())
        .expect(200);

      // Two nights at 1,200.00 = 2,400.00 net, +10% service, +7% VAT on the sum.
      expect(response.body.revenue.room.amount).toBe(240_000);
      expect(response.body.revenue.serviceCharge.amount).toBe(24_000);
      expect(response.body.revenue.total.amount).toBe(264_000);
      expect(response.body.vat.output.amount).toBe(18_480);
      // The VAT is reported and is not part of revenue.
      expect(response.body.revenue.total.amount).not.toBe(282_480);
    });

    it('subtracts costs and groups them for reading', async () => {
      await book('2031-05-10', '2031-05-12');
      await postExpense({
        categoryId: await categoryId('ELECTRICITY'),
        description: 'PEA',
        amount: 50_000,
        expenseDate: '2031-05-15',
      }).expect(201);
      await postExpense({
        categoryId: await categoryId('SALARY'),
        description: 'May wages',
        amount: 150_000,
        expenseDate: '2031-05-28',
      }).expect(201);

      const response = await request(app.getHttpServer())
        .get(`${base}/reports/profit-loss?from=${MONTH_FROM}&to=${MONTH_TO}`)
        .set(asOwner())
        .expect(200);

      expect(response.body.totalExpenses.amount).toBe(200_000);
      expect(response.body.netProfit.amount).toBe(64_000);
      expect(response.body.expenseGroups.map((g: { group: string }) => g.group)).toEqual([
        'PAYROLL',
        'UTILITIES',
      ]);
    });

    it("keeps an owner's drawing out of profit but still reports it", async () => {
      await postExpense({
        categoryId: await categoryId('OWNER_DRAW'),
        description: 'Cash taken',
        amount: 500_000,
        expenseDate: '2031-05-20',
      }).expect(201);

      const response = await request(app.getHttpServer())
        .get(`${base}/reports/profit-loss?from=${MONTH_FROM}&to=${MONTH_TO}`)
        .set(asOwner())
        .expect(200);

      expect(response.body.totalExpenses.amount).toBe(0);
      expect(response.body.nonDeductibleExpenses.amount).toBe(500_000);
      expect(response.body.netProfit.amount).toBe(0);
      expect(response.body.retained.amount).toBe(-500_000);
    });
  });

  describe('the cash book', () => {
    /**
     * The window is a day wide and sits on today, because a folio payment is
     * dated when the money was taken — the property's current business date —
     * not when the guest will sleep. The booking is in 2031; the payment is
     * now. That gap is the point.
     */
    it('records a guest payment in and a supplier payment out', async () => {
      const { rows } = await pool.query<{ today: string }>(
        `SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`,
      );
      const today = rows[0]!.today;
      const tomorrow = addDays(today, 1);

      const booking = await book('2031-05-10', '2031-05-12');
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/reservations/${booking.id}/folio/payments`)
        .set(asOwner())
        .send({ kind: 'PAYMENT', method: 'CASH', amount: 100_000 })
        .expect(201);

      await postExpense({
        categoryId: await categoryId('LAUNDRY'),
        description: 'Laundry',
        amount: 30_000,
        expenseDate: today,
        paidDate: today,
        paymentMethod: 'CASH',
      }).expect(201);

      const response = await request(app.getHttpServer())
        .get(`${base}/reports/cash-book?from=${today}&to=${tomorrow}`)
        .set(asOwner())
        .expect(200);

      expect(response.body.totalReceived.amount).toBe(100_000);
      expect(response.body.totalPaid.amount).toBe(30_000);
      expect(response.body.closingBalance.amount).toBe(70_000);
      expect(response.body.items).toHaveLength(2);
      // Takings before payments, the way a cash book is counted.
      expect(response.body.items[0].received.amount).toBe(100_000);
    });

    /**
     * Tax withheld has not left the hotel's hands yet. Recording the gross here
     * would take the same baht out of the bank twice — once now and again when
     * it is remitted.
     */
    it('records only what the supplier actually received', async () => {
      await postExpense({
        categoryId: await categoryId('RENT'),
        description: 'Ground rent',
        amount: 100_000,
        amountIs: 'NET',
        whtRateBp: 500,
        expenseDate: '2031-05-01',
        paidDate: '2031-05-01',
        paymentMethod: 'BANK_TRANSFER',
      }).expect(201);

      const response = await request(app.getHttpServer())
        .get(`${base}/reports/cash-book?from=${MONTH_FROM}&to=${MONTH_TO}`)
        .set(asOwner())
        .expect(200);

      expect(response.body.totalPaid.amount).toBe(95_000);
    });
  });

  // -------------------------------------------------------------- permissions

  describe('who can see what', () => {
    it('lets a MANAGER record an expense', async () => {
      await postExpense(
        {
          categoryId: await categoryId('ELECTRICITY'),
          description: 'PEA, entered by the manager',
          amount: 60_000,
          expenseDate: '2031-05-14',
        },
        asManager(),
      ).expect(201);
    });

    /** The distinction the module exists to preserve — see accounting-plan.md §6. */
    it('does not show a MANAGER the profit or the tax identity', async () => {
      await request(app.getHttpServer())
        .get(`${base}/reports/profit-loss?from=${MONTH_FROM}&to=${MONTH_TO}`)
        .set(asManager())
        .expect(403);

      await request(app.getHttpServer())
        .get(`${base}/summary?year=2031&month=5`)
        .set(asManager())
        .expect(403);

      await request(app.getHttpServer()).get(`${base}/settings`).set(asManager()).expect(403);
    });

    it('does not let a MANAGER void an expense', async () => {
      const created = await postExpense({
        categoryId: await categoryId('MISC'),
        description: 'Manager cannot unmake this',
        amount: 1_000,
        expenseDate: '2031-05-16',
      }).expect(201);

      await request(app.getHttpServer())
        .post(`${base}/expenses/${created.body.id}/void`)
        .set(asManager())
        .send({ reason: 'nope' })
        .expect(403);
    });

    it('shows FRONT_DESK and READ_ONLY nothing at all', async () => {
      for (const token of [deskToken, readerToken]) {
        const headers = { Authorization: `Bearer ${token}` };
        await request(app.getHttpServer()).get(`${base}/categories`).set(headers).expect(403);
        await request(app.getHttpServer())
          .get(`${base}/expenses?from=${MONTH_FROM}&to=${MONTH_TO}`)
          .set(headers)
          .expect(403);
        await request(app.getHttpServer())
          .get(`${base}/reports/profit-loss?from=${MONTH_FROM}&to=${MONTH_TO}`)
          .set(headers)
          .expect(403);
      }
    });

    /** 404 rather than 403: a 403 would confirm the property exists. */
    it("returns 404 for another organization's property", async () => {
      await request(app.getHttpServer())
        .get(`${base}/categories`)
        .set({ Authorization: `Bearer ${otherToken}` })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------- settings

  describe('taxpayer settings', () => {
    it('rejects a tax ID whose check digit does not agree', async () => {
      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ taxId: '0105556012345' })
        .expect(422);
    });

    it('accepts one written with the punctuation printed on invoices', async () => {
      const response = await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ taxId: '0-1055-56012-34-1', taxpayerType: 'JURISTIC' })
        .expect(200);

      expect(response.body.taxId).toBe('0105556012341');
    });

    it('refuses VAT registration with no effective date', async () => {
      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ vatRegistered: true })
        .expect(422);
    });

    it('reports defaults for a property nobody has configured', async () => {
      const response = await request(app.getHttpServer())
        .get(`${base}/settings`)
        .set(asOwner())
        .expect(200);

      expect(response.body.vatRegistered).toBe(false);
      expect(response.body.branchCode).toBe('00000');
      expect(response.body.taxpayerType).toBeNull();
    });
  });

  // ----------------------------------------------------------------- summary

  describe('the monthly summary', () => {
    it('defaults to the basis the taxpayer actually files on', async () => {
      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ taxpayerType: 'JURISTIC' })
        .expect(200);

      const juristic = await request(app.getHttpServer())
        .get(`${base}/summary?year=2031&month=5`)
        .set(asOwner())
        .expect(200);
      expect(juristic.body.basis).toBe('ACCRUAL');

      await request(app.getHttpServer())
        .put(`${base}/settings`)
        .set(asOwner())
        .send({ taxpayerType: 'INDIVIDUAL' })
        .expect(200);

      const individual = await request(app.getHttpServer())
        .get(`${base}/summary?year=2031&month=5`)
        .set(asOwner())
        .expect(200);
      expect(individual.body.basis).toBe('CASH');
    });

    it('names the recurring bills that have not been entered yet', async () => {
      const electricity = await categoryId('ELECTRICITY');
      await pool.query(
        `INSERT INTO expense_recurrences (id, organization_id, property_id, category_id, label,
                                          day_of_month, currency)
         VALUES ($1, $2, $3, $4, 'ค่าไฟฟ้า', 5, 'THB')`,
        [crypto.randomUUID(), orgId, propertyId, electricity],
      );

      const before = await request(app.getHttpServer())
        .get(`${base}/summary?year=2031&month=5`)
        .set(asOwner())
        .expect(200);
      expect(before.body.missingRecurring.map((m: { label: string }) => m.label)).toEqual([
        'ค่าไฟฟ้า',
      ]);

      await postExpense({
        categoryId: electricity,
        description: 'PEA May',
        amount: 90_000,
        expenseDate: '2031-05-05',
      }).expect(201);

      const after = await request(app.getHttpServer())
        .get(`${base}/summary?year=2031&month=5`)
        .set(asOwner())
        .expect(200);
      expect(after.body.missingRecurring).toHaveLength(0);
    });

    it('rejects a month outside 1–12', async () => {
      await request(app.getHttpServer())
        .get(`${base}/summary?year=2031&month=13`)
        .set(asOwner())
        .expect(422);
    });
  });

  async function book(checkIn: string, checkOut: string) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(asOwner())
      .send({
        source: 'PHONE',
        booker: { name: 'Naruemon Chaiyaporn' },
        stays: [{ roomTypeId: deluxeId, ratePlanId: deluxePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return { id: response.body.id as string };
  }
});

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
