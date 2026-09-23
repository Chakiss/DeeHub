/**
 * The booking page's second half — what a guest sees before choosing dates,
 * what a stay costs all-in, and paying for it — against real PostgreSQL with
 * the payment provider faked at the port.
 *
 * The fake stands in for Omise. What is under test is the protocol around
 * it: a webhook is a prompt and never a fact, a paid charge confirms once
 * however many times it is reported, and money that lands on a booking that
 * moved is recorded loudly rather than lost.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';
import type {
  ChargeState,
  PaymentGateway,
  PaymentMethod,
  StartChargeOutcome,
  StartChargeRequest,
} from './domain/payment-gateway';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. Booking payment e2e tests must run against Postgres.',
  );
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

const NIGHTS = [0, 1, 2, 3].map((offset) =>
  new Date(Date.now() + (40 + offset) * 86_400_000).toISOString().slice(0, 10),
) as unknown as readonly [string, string, string, string];
const RATE_MINOR = 100000;
const DESK_RATE_MINOR = 50000;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * A provider in a box. `charges` is what it knows; `answer` is what it will
 * say about a charge when asked, which a test changes to simulate the bank.
 */
class FakeGateway implements PaymentGateway {
  readonly provider = 'fake';
  configured = true;
  nextOutcome: StartChargeOutcome | null = null;
  readonly answers = new Map<string, ChargeState>();
  readonly started: StartChargeRequest[] = [];
  /** The provider reference the last successful start handed out. */
  lastReference = '';
  fetches = 0;
  private counter = 0;

  isConfigured(): boolean {
    return this.configured;
  }

  methods(): readonly PaymentMethod[] {
    return this.configured ? ['CARD', 'PROMPTPAY'] : [];
  }

  async startCharge(req: StartChargeRequest): Promise<StartChargeOutcome> {
    this.started.push(req);
    if (this.nextOutcome) {
      const outcome = this.nextOutcome;
      this.nextOutcome = null;
      return outcome;
    }
    this.counter += 1;
    const id = `chrg_test_${String(this.counter)}`;
    this.lastReference = id;
    if (req.method === 'CARD') {
      this.answers.set(id, { status: 'PAID' });
      return { status: 'PAID', providerReference: id };
    }
    this.answers.set(id, { status: 'PENDING' });
    return {
      status: 'PENDING',
      providerReference: id,
      authorizeUri: null,
      qrImageUri: `https://fake.test/qr/${id}.svg`,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  async fetchCharge(ref: string): Promise<ChargeState> {
    this.fetches += 1;
    const state = this.answers.get(ref);
    if (!state) throw new Error(`unknown charge ${ref}`);
    return state;
  }
}

describeIfDb('Booking engine — catalog, prices and payment', () => {
  let app: INestApplication;
  let pool: Pool;
  const gateway = new FakeGateway();

  const orgId = crypto.randomUUID();
  const orgSlug = `bp-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const onlinePlanId = crypto.randomUUID();
  const deskPlanId = crypto.randomUUID();
  const mediaId = crypto.randomUUID();

  beforeAll(async () => {
    const { AppModule } = await import('../../app.module');
    const { DATABASE_POOL } = await import('../../database/database.module');
    const { DomainExceptionFilter } = await import('../../common/filters/domain-exception.filter');
    const { PAYMENT_GATEWAY } = await import('./domain/payment-gateway');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
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
    // 7% VAT on top of a 10% service charge, prices net — the breakdown is
    // the point of half these tests.
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                               tax_rate_bp, service_charge_rate_bp, prices_include_tax,
                               website, latitude, longitude, description_en, amenities, phone)
       VALUES ($1, $2, 'MAIN', 'Payments Hotel', 'Asia/Bangkok', 'THB', 'TH', 700, 1000, false,
               'https://payments.example', 12.9236, 100.8825, 'Quiet.', '["Wi-Fi","Pool"]', '063')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name, description,
                               bed_config, size_sqm, standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe', 'A deluxe room', '1 king bed', 32, 2, 3, 3, 1)`,
      [deluxeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name, sell_online, is_refundable)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available', true, true),
              ($5, $2, $3, $4, 'DESK', 'Walk-in special', false, false)`,
      [onlinePlanId, orgId, propertyId, deluxeId, deskPlanId],
    );
    await pool.query(
      `INSERT INTO media (id, organization_id, property_id, kind, room_type_id, object_key, content_type, bytes, sort_order)
       VALUES ($1, $2, $3, 'ROOM_TYPE', $4, $5, 'image/jpeg', 1000, 0)`,
      [mediaId, orgId, propertyId, deluxeId, `public/${orgId}/${propertyId}/${mediaId}.jpg`],
    );
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'payment_intents',
      'folio_payments',
      'folio_charges',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'media',
      'rate_days',
      'inventory_days',
      'rate_plans',
      'room_types',
      'properties',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await app.close();
  });

  beforeEach(async () => {
    gateway.configured = true;
    gateway.nextOutcome = null;
    for (const table of [
      'audit_logs',
      'outbox_events',
      'payment_intents',
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
    for (const date of NIGHTS) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 5)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const [plan, amount] of [
        [onlinePlanId, RATE_MINOR],
        [deskPlanId, DESK_RATE_MINOR],
      ] as const) {
        for (const occupancy of [1, 2, 3]) {
          await pool.query(
            `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
             VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
            [orgId, propertyId, plan, date, occupancy, amount],
          );
        }
      }
    }
  });

  const url = (suffix = '') => `/api/v1/public/${orgSlug}/MAIN${suffix}`;
  const EMAIL = 'ploy@example.test';

  async function hold(nights = 1): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(url('/bookings'))
      .send({
        guest: { name: 'Ploy Sukhum', email: EMAIL, phone: '0812345678' },
        checkIn: NIGHTS[0],
        checkOut: addDays(NIGHTS[0], nights),
        stays: [{ roomTypeId: deluxeId, ratePlanId: onlinePlanId, adults: 2 }],
      })
      .expect(201);
    return response.body.code as string;
  }

  async function statusOf(code: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE code = $1',
      [code],
    );
    return rows[0]?.status ?? 'MISSING';
  }

  it('shows the hotel with its photos, rooms and only the plans a stranger may buy', async () => {
    const response = await request(app.getHttpServer()).get(url()).expect(200);
    expect(response.body.name).toBe('Payments Hotel');
    expect(response.body.website).toBe('https://payments.example');
    expect(response.body.latitude).toBeCloseTo(12.9236, 4);
    expect(response.body.amenities).toEqual(['Wi-Fi', 'Pool']);
    expect(response.body.tax).toEqual({
      vatPercent: 7,
      serviceChargePercent: 10,
      pricesIncludeTax: false,
    });
    expect(response.body.paymentMethods).toEqual(['CARD', 'PROMPTPAY']);

    const room = response.body.roomTypes[0];
    expect(room.name).toBe('Deluxe');
    expect(room.bedConfig).toBe('1 king bed');
    expect(room.sizeSqm).toBe(32);
    expect(room.photos[0].url).toContain(`${mediaId}.jpg`);
    expect(room.ratePlans.map((plan: { code: string }) => plan.code)).toEqual(['BAR']);
    // Nothing that names the tenant.
    expect(response.body).not.toHaveProperty('id');
    expect(response.body).not.toHaveProperty('organizationId');
  });

  it('prices a stay all-in, from the same arithmetic a booking uses', async () => {
    const response = await request(app.getHttpServer())
      .get(`${url('/availability')}?checkIn=${NIGHTS[0]}&checkOut=${addDays(NIGHTS[0], 2)}`)
      .expect(200);
    const room = response.body.roomTypes[0];
    const plan = room.ratePlans[0];
    expect(plan.total).toBe(RATE_MINOR * 2);
    // 200,000 net → +10% SC = 220,000 → +7% VAT = 235,400
    expect(plan.breakdown).toEqual({
      subtotal: 200000,
      serviceCharge: 20000,
      tax: 15400,
      total: 235400,
    });
    expect(room.fromTotal).toBe(235400);
    expect(plan.isRefundable).toBe(true);
    // The desk-only plan is cheaper and must not be here.
    expect(room.ratePlans).toHaveLength(1);

    const code = await hold(2);
    const { rows } = await pool.query<{ total_minor: number }>(
      'SELECT total_minor FROM reservations WHERE code = $1',
      [code],
    );
    expect(Number(rows[0]?.total_minor)).toBe(235400);
  });

  it('answers a calendar with the cheapest all-in night, and nothing for a stopped one', async () => {
    await pool.query(
      'UPDATE inventory_days SET stop_sell = true WHERE room_type_id = $1 AND date = $2',
      [deluxeId, NIGHTS[1]],
    );
    const response = await request(app.getHttpServer())
      .get(`${url('/lowest')}?from=${NIGHTS[0]}&to=${addDays(NIGHTS[0], 3)}`)
      .expect(200);
    const byDate = new Map(
      response.body.nights.map((night: { date: string; fromTotalMinor: number | null }) => [
        night.date,
        night.fromTotalMinor,
      ]),
    );
    // 100,000 → 110,000 → 117,700, from the online plan, never the desk one.
    expect(byDate.get(NIGHTS[0])).toBe(117700);
    expect(byDate.get(NIGHTS[1])).toBeNull();
    expect(byDate.get(NIGHTS[2])).toBe(117700);
  });

  it('caps the unpaid holds one email may leave open', async () => {
    await hold();
    await hold();
    await hold();
    const response = await request(app.getHttpServer())
      .post(url('/bookings'))
      .send({
        guest: { name: 'Ploy Sukhum', email: EMAIL.toUpperCase() },
        checkIn: NIGHTS[2],
        checkOut: NIGHTS[3],
        stays: [{ roomTypeId: deluxeId, ratePlanId: onlinePlanId, adults: 2 }],
      })
      .expect(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
  });

  it('shows a booking to the email that made it, and to nobody else', async () => {
    const code = await hold();
    const mine = await request(app.getHttpServer())
      .get(`${url(`/bookings/${code}`)}?email=${encodeURIComponent(EMAIL)}`)
      .expect(200);
    expect(mine.body.status).toBe('PENDING');
    expect(mine.body.stays[0].roomTypeName).toBe('Deluxe');
    expect(mine.body.total).toBe(117700);
    expect(mine.body.payment).toBeNull();

    await request(app.getHttpServer())
      .get(`${url(`/bookings/${code}`)}?email=someone-else@example.test`)
      .expect(404);
    await request(app.getHttpServer())
      .get(url(`/bookings/${code}`))
      .expect(422);
  });

  it('confirms a card the bank clears in one round trip, on the folio, with a confirmation owed', async () => {
    const code = await hold();
    const response = await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'CARD', token: 'tokn_test', returnUri: 'https://book.example/return' })
      .expect(200);
    expect(response.body.status).toBe('PAID');
    expect(response.body.reservationStatus).toBe('CONFIRMED');
    expect(gateway.started[gateway.started.length - 1]?.amountMinor).toBe(117700);

    expect(await statusOf(code)).toBe('CONFIRMED');
    const folio = await pool.query(
      `SELECT method, amount_minor, reference FROM folio_payments fp
        JOIN reservations r ON r.id = fp.reservation_id WHERE r.code = $1`,
      [code],
    );
    expect(folio.rows[0]).toMatchObject({
      method: 'CARD',
      reference: expect.stringMatching(/^chrg_/),
    });
    expect(Number(folio.rows[0].amount_minor)).toBe(117700);
    const events = await pool.query(
      `SELECT payload FROM outbox_events WHERE organization_id = $1 AND event_type = 'reservation.status_changed'`,
      [orgId],
    );
    expect(
      events.rows.some((row) => (row.payload as { status: string }).status === 'CONFIRMED'),
    ).toBe(true);
  });

  it('gives PromptPay a QR, stays pending, then confirms once the provider says paid — once', async () => {
    const code = await hold();
    const started = await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'PROMPTPAY', returnUri: 'https://book.example/return' })
      .expect(200);
    expect(started.body.status).toBe('PENDING');
    expect(started.body.qrImageUri).toMatch(/\.svg$/);
    const intentId = started.body.intentId as string;
    const ref = gateway.lastReference;
    expect(await statusOf(code)).toBe('PENDING');

    // The hold was pushed out past the fifteen minutes so the QR outlives it.
    const holdRow = await pool.query<{ secs: number }>(
      `SELECT extract(epoch from (hold_expires_at - now()))::int AS secs FROM reservations WHERE code = $1`,
      [code],
    );
    expect(holdRow.rows[0]!.secs).toBeGreaterThan(20 * 60);

    // Starting again does not start a second charge.
    const again = await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'PROMPTPAY', returnUri: 'https://book.example/return' })
      .expect(200);
    expect(again.body.intentId).toBe(intentId);

    // A forged webhook claims nothing: the provider still says pending.
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/omise')
      .send({ object: 'event', key: 'charge.complete', data: { object: 'charge', id: ref } })
      .expect(200);
    expect(await statusOf(code)).toBe('PENDING');

    // Poll: still pending.
    const poll = await request(app.getHttpServer())
      .get(`${url(`/bookings/${code}/payments/${intentId}`)}?email=${EMAIL}`)
      .expect(200);
    expect(poll.body.outcome).toBe('PENDING');

    // The guest scans; the provider now says paid; the webhook lands twice.
    gateway.answers.set(ref, { status: 'PAID' });
    for (let i = 0; i < 2; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/omise')
        .send({ object: 'event', key: 'charge.complete', data: { object: 'charge', id: ref } })
        .expect(200);
    }
    expect(await statusOf(code)).toBe('CONFIRMED');
    const payments = await pool.query(
      `SELECT count(*)::int AS n FROM folio_payments fp JOIN reservations r ON r.id = fp.reservation_id WHERE r.code = $1`,
      [code],
    );
    expect(payments.rows[0].n).toBe(1);
    const settled = await request(app.getHttpServer())
      .get(`${url(`/bookings/${code}/payments/${intentId}`)}?email=${EMAIL}`)
      .expect(200);
    expect(settled.body.outcome).toBe('PAID');
    expect(settled.body.reservationStatus).toBe('CONFIRMED');
  });

  it('leaves a declined card pending and says why', async () => {
    const code = await hold();
    gateway.nextOutcome = { status: 'DECLINED', reason: 'insufficient funds', retryable: false };
    const response = await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'CARD', token: 'tokn_test', returnUri: 'https://book.example/return' })
      .expect(200);
    expect(response.body).toMatchObject({ status: 'DECLINED', reason: 'insufficient funds' });
    expect(await statusOf(code)).toBe('PENDING');
    const intents = await pool.query(
      'SELECT count(*)::int AS n FROM payment_intents WHERE organization_id = $1',
      [orgId],
    );
    expect(intents.rows[0].n).toBe(0);
  });

  it('records money that arrives for a booking that already moved, and shouts', async () => {
    const code = await hold();
    const started = await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'PROMPTPAY', returnUri: 'https://book.example/return' })
      .expect(200);
    const ref = gateway.lastReference;
    // The desk cancels while the QR is on the guest's screen.
    await pool.query(
      `UPDATE reservations SET status = 'CANCELLED', cancelled_at = now() WHERE code = $1`,
      [code],
    );
    gateway.answers.set(ref, { status: 'PAID' });

    const poll = await request(app.getHttpServer())
      .get(`${url(`/bookings/${code}/payments/${started.body.intentId as string}`)}?email=${EMAIL}`)
      .expect(200);
    expect(poll.body.outcome).toBe('PAID_UNCONFIRMABLE');
    expect(await statusOf(code)).toBe('CANCELLED');
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'booking_engine.payment_unconfirmable'`,
      [orgId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('refuses a return address that is not a URL, and a method the hotel lacks', async () => {
    const code = await hold();
    await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'CARD', token: 'tokn_test', returnUri: 'not a url' })
      .expect(422);
    gateway.configured = false;
    const off = await request(app.getHttpServer())
      .post(url(`/bookings/${code}/payments`))
      .send({ method: 'PROMPTPAY', returnUri: 'https://book.example/return' })
      .expect(200);
    expect(off.body.status).toBe('UNAVAILABLE');
  });
});
