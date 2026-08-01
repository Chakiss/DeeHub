/**
 * The guest's account, against real PostgreSQL.
 *
 * The arithmetic is covered by `domain/folio.test.ts`; what these add is
 * everything the database decides — that a void cannot happen twice, that a
 * line cannot be reached through the wrong booking, that the balance a
 * check-out reports is the one that was true at that moment, and that a front
 * desk can take money without being able to un-take it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Folio e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

/** Far future, so these stays never become "begun" while the suite runs. */
const NIGHTS = ['2031-05-01', '2031-05-02', '2031-05-03', '2031-05-04', '2031-05-05'] as const;
const RATE_MINOR = 120000;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describeIfDb('Folio', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'folio-e2e-password';

  const orgId = crypto.randomUUID();
  const orgSlug = `fo-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const deluxeId = crypto.randomUUID();
  const deluxePlanId = crypto.randomUUID();
  const roomAId = crypto.randomUUID();
  const roomBId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const readerId = crypto.randomUUID();

  let token = '';
  let readerToken = '';
  /** Today in the property's timezone — the in-house cases need real dates. */
  let today = '';

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
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                               tax_rate_bp, service_charge_rate_bp)
       VALUES ($1, $2, 'MAIN', 'Folio Hotel', 'Asia/Bangkok', 'THB', 'TH', 700, 1000)`,
      [propertyId, orgId],
    );
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
    for (const [roomId, number] of [
      [roomAId, '301'],
      [roomBId, '302'],
    ] as const) {
      await pool.query(
        `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [roomId, orgId, propertyId, deluxeId, number],
      );
    }

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

    const { rows } = await pool.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`,
    );
    today = rows[0]!.today;

    token = await tokenFor(`manager-${orgSlug}@e2e.test`);
    readerToken = await tokenFor(`reader-${orgSlug}@e2e.test`);
  });

  afterAll(async () => {
    for (const table of [
      'audit_logs',
      'outbox_events',
      'folio_payments',
      'folio_charges',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'physical_rooms',
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
      'folio_charges',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'rate_days',
      'inventory_days',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
    }

    // Two sellable units at one price, over the far-future window AND a window
    // around today for the in-house cases.
    // Negative offsets too: one case backdates a stay so it has nights the
    // guest has already slept through, which cannot be created through the API.
    const dates = [...NIGHTS, ...[-2, -1, 0, 1, 2, 3, 4].map((offset) => addDays(today, offset))];
    for (const date of dates) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment)
         VALUES ($1, $2, $3, $4, 2)`,
        [orgId, propertyId, deluxeId, date],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
          [orgId, propertyId, deluxePlanId, date, occupancy, RATE_MINOR],
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

  async function book(checkIn: string, checkOut: string) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'PHONE',
        booker: { name: 'Naruemon Chaiyaporn' },
        stays: [{ roomTypeId: deluxeId, ratePlanId: deluxePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return {
      reservationId: response.body.id as string,
      stayId: response.body.stays[0].id as string,
    };
  }

  const readerAuth = () => ({ Authorization: `Bearer ${readerToken}` });

  function folioUrl(reservationId: string, suffix = ''): string {
    return `/api/v1/properties/${propertyId}/reservations/${reservationId}/folio${suffix}`;
  }

  function getFolio(reservationId: string) {
    return request(app.getHttpServer()).get(folioUrl(reservationId)).set(auth());
  }

  function postCharge(reservationId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(folioUrl(reservationId, '/charges'))
      .set(auth())
      .send(body);
  }

  function postPayment(reservationId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(folioUrl(reservationId, '/payments'))
      .set(auth())
      .send(body);
  }

  /**
   * Move a checked-in stay's arrival into the past.
   *
   * The booking path refuses an arrival in the past — correctly — but "the
   * guest checked in two days ago" is the state early departure exists for, so
   * the tests that need it fabricate exactly that one column and the night rows
   * that go with it. Everything else came through the real API.
   */
  async function backdateArrival(
    reservationId: string,
    stayId: string,
    nightsBefore: number,
  ): Promise<void> {
    await pool.query('UPDATE reservation_stays SET check_in = $1 WHERE id = $2', [
      addDays(today, -nightsBefore),
      stayId,
    ]);

    for (let offset = -nightsBefore; offset < 0; offset += 1) {
      await pool.query(
        `INSERT INTO reservation_stay_nights
           (stay_id, date, organization_id, reservation_id, property_id, room_type_id,
            amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'THB')`,
        [stayId, addDays(today, offset), orgId, reservationId, propertyId, deluxeId, RATE_MINOR],
      );
      await pool.query(
        `UPDATE inventory_days SET booked = booked + 1 WHERE room_type_id = $1 AND date = $2`,
        [deluxeId, addDays(today, offset)],
      );
    }
  }

  async function bookedOn(date: string): Promise<number> {
    const { rows } = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [deluxeId, date],
    );
    return rows[0]?.booked ?? -1;
  }

  async function detail(reservationId: string) {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/reservations/${reservationId}`)
      .set(auth())
      .expect(200);
    return response.body;
  }

  /**
   * Assign a room and check the booking in, the way a front desk would.
   *
   * Returns the version as the API now reports it — check-in bumps it, and
   * hard-coding the new number here would make these tests pass for the wrong
   * reason if that ever changed.
   */
  async function checkIn(reservationId: string, stayId: string, roomId: string) {
    await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/stays/${stayId}/room`)
      .set(auth())
      .send({ roomId })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-in`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    const body = await detail(reservationId);
    return body.version as number;
  }

  it('bills the room nights at the price the guest was quoted', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 2));

    const response = await getFolio(reservationId).expect(200);
    expect(response.body.roomCharges).toHaveLength(2);
    expect(response.body.totals.roomSubtotal).toBe(RATE_MINOR * 2);
    // 10% service, then 7% VAT on the sum — the Thai order (ADR-0003).
    expect(response.body.totals.serviceCharge).toBe(RATE_MINOR * 2 * 0.1);
    expect(response.body.totals.balance).toBe(response.body.totals.chargesTotal);
  });

  it('follows the booking when the stay is shortened', async () => {
    const { reservationId, stayId } = await book(NIGHTS[0], addDays(NIGHTS[0], 3));
    const before = await getFolio(reservationId).expect(200);

    await request(app.getHttpServer())
      .post(
        `/api/v1/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/shorten`,
      )
      .set(auth())
      .send({ version: 0, checkOut: addDays(NIGHTS[0], 1) })
      .expect(200);

    const after = await getFolio(reservationId).expect(200);
    // Room charges are read from the reservation rather than copied, so there
    // is no second number that could have been left behind.
    expect(after.body.roomCharges).toHaveLength(1);
    expect(after.body.totals.chargesTotal).toBeLessThan(before.body.totals.chargesTotal);
  });

  it('puts an extra on the bill and taxes it like the room', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const roomOnly = await getFolio(reservationId).expect(200);

    const response = await postCharge(reservationId, {
      kind: 'MINIBAR',
      description: 'Two beers',
      amount: 15000,
    }).expect(201);

    expect(response.body.extraCharges).toHaveLength(1);
    expect(response.body.extraCharges[0].postedBy).toBeTruthy();
    expect(response.body.totals.extrasSubtotal).toBe(15000);
    // Composed with the room, not taxed separately: a second rounding would put
    // the total a baht away from the sum of the printed lines.
    expect(response.body.totals.chargesTotal).toBeGreaterThan(
      roomOnly.body.totals.chargesTotal + 15000,
    );
  });

  it('leaves an untaxed charge out of the tax', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const before = await getFolio(reservationId).expect(200);

    const response = await postCharge(reservationId, {
      kind: 'DAMAGE',
      amount: 50000,
      taxable: false,
    }).expect(201);

    // A damage recovery is not a sale; VAT on it would overcharge the guest.
    expect(response.body.totals.tax).toBe(before.body.totals.tax);
    expect(response.body.totals.chargesTotal).toBe(before.body.totals.chargesTotal + 50000);
  });

  it('records who took the money and on which trading day', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));

    const response = await postPayment(reservationId, {
      method: 'CASH',
      amount: 50000,
    }).expect(201);

    const paid = response.body.payments[0];
    expect(paid.recordedBy).toBeTruthy();
    // The property's trading day, not the server's calendar.
    expect(paid.businessDate).toBe(today);
    expect(response.body.totals.paid).toBe(50000);
  });

  it('lets a guest overpay and shows the hotel owing them', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));

    const response = await postPayment(reservationId, {
      method: 'CASH',
      amount: 99_000_00,
    }).expect(201);

    // A deposit larger than the bill so far is normal; refusing it sends the
    // desk to a notebook.
    expect(response.body.totals.balance).toBeLessThan(0);
  });

  it('refuses a refund larger than what was ever taken', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    await postPayment(reservationId, { method: 'CASH', amount: 50000 }).expect(201);

    // Not a rounding problem: a cashier typing into the wrong booking.
    await postPayment(reservationId, {
      kind: 'REFUND',
      method: 'CASH',
      amount: 50001,
    }).expect(422);

    await postPayment(reservationId, {
      kind: 'REFUND',
      method: 'CASH',
      amount: 50000,
    }).expect(201);
  });

  it('keeps a voided payment on the folio and out of the total', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const recorded = await postPayment(reservationId, { method: 'CASH', amount: 50000 }).expect(
      201,
    );
    const paymentId = recorded.body.payments[0].id as string;

    const response = await request(app.getHttpServer())
      .post(folioUrl(reservationId, `/payments/${paymentId}/void`))
      .set(auth())
      .send({ reason: 'Keyed against the wrong booking' })
      .expect(200);

    expect(response.body.totals.paid).toBe(0);
    // Still there. "Charged and reversed" is a different fact from "never
    // charged", and it is the one somebody wants when a till does not balance.
    expect(response.body.payments).toHaveLength(1);
    expect(response.body.payments[0].voidedAt).toBeTruthy();
    expect(response.body.payments[0].voidedReason).toBe('Keyed against the wrong booking');
  });

  it('refuses to void the same line twice', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const recorded = await postPayment(reservationId, { method: 'CASH', amount: 50000 }).expect(
      201,
    );
    const paymentId = recorded.body.payments[0].id as string;

    for (const expected of [200, 409]) {
      // Two clerks clicking void on one mis-keyed payment must not each record
      // a reversal; the database decides which one wins.
      await request(app.getHttpServer())
        .post(folioUrl(reservationId, `/payments/${paymentId}/void`))
        .set(auth())
        .send({ reason: 'Duplicate' })
        .expect(expected);
    }
  });

  it('refuses to void a line through a booking it does not belong to', async () => {
    const mine = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const theirs = await book(NIGHTS[2], addDays(NIGHTS[2], 1));
    const recorded = await postPayment(theirs.reservationId, {
      method: 'CASH',
      amount: 50000,
    }).expect(201);

    await request(app.getHttpServer())
      .post(folioUrl(mine.reservationId, `/payments/${recorded.body.payments[0].id}/void`))
      .set(auth())
      .send({ reason: 'Wrong booking' })
      .expect(409);
  });

  it('refuses a void with no reason', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const recorded = await postPayment(reservationId, { method: 'CASH', amount: 50000 }).expect(
      201,
    );

    await request(app.getHttpServer())
      .post(folioUrl(reservationId, `/payments/${recorded.body.payments[0].id}/void`))
      .set(auth())
      .send({ reason: '   ' })
      .expect(422);
  });

  it('refuses to charge a cancelled booking', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/cancel`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    // Whatever it costs the guest now is a cancellation fee, which is a
    // decision the hotel makes rather than a minibar line on a stay nobody took.
    await postCharge(reservationId, { kind: 'MINIBAR', amount: 15000 }).expect(409);
  });

  it('still accepts a charge after check-out', async () => {
    const { reservationId, stayId } = await book(today, addDays(today, 1));
    await checkIn(reservationId, stayId, roomAId);
    const detailBefore = await detail(reservationId);
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
      .set(auth())
      .send({ version: detailBefore.version })
      .expect(200);

    // The minibar is checked after the guest leaves. Refusing this would send
    // the front desk to a spreadsheet.
    await postCharge(reservationId, { kind: 'MINIBAR', amount: 15000 }).expect(201);
  });

  it('tells check-out what the guest still owes, without refusing them', async () => {
    const { reservationId, stayId } = await book(today, addDays(today, 1));
    await checkIn(reservationId, stayId, roomAId);
    const current = await detail(reservationId);

    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
      .set(auth())
      .send({ version: current.version })
      .expect(200);

    /*
     * Reported, never enforced. Plenty of departures are legitimately unsettled
     * — an OTA has collected, a company is billed monthly — and blocking one
     * would stop a guest leaving over a bill nobody meant to collect at the desk.
     */
    expect(response.body.outstandingBalance).toBeGreaterThan(0);
    expect(response.body.status).toBe('CHECKED_OUT');
  });

  it('reports a settled guest as owing nothing', async () => {
    const { reservationId, stayId } = await book(today, addDays(today, 1));
    await checkIn(reservationId, stayId, roomAId);

    const folio = await getFolio(reservationId).expect(200);
    await postPayment(reservationId, {
      method: 'CARD',
      amount: folio.body.totals.chargesTotal,
    }).expect(201);

    const current = await detail(reservationId);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservationId}/check-out`)
      .set(auth())
      .send({ version: current.version })
      .expect(200);

    expect(response.body.outstandingBalance).toBe(0);
  });

  it('lets a front desk take money and not un-take it', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    const recorded = await postPayment(reservationId, { method: 'CASH', amount: 50000 }).expect(
      201,
    );

    // READ_ONLY cannot even read the folio's money — see capabilities.ts, where
    // `folio:read` lands in the blanket read bundle and `folio:void` does not.
    await request(app.getHttpServer())
      .post(folioUrl(reservationId, `/payments/${recorded.body.payments[0].id}/void`))
      .set(readerAuth())
      .send({ reason: 'Nope' })
      .expect(403);
  });

  it('records every money movement in the audit trail', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));
    await postCharge(reservationId, { kind: 'LAUNDRY', amount: 20000 }).expect(201);
    const recorded = await postPayment(reservationId, { method: 'CASH', amount: 50000 }).expect(
      201,
    );
    await request(app.getHttpServer())
      .post(folioUrl(reservationId, `/payments/${recorded.body.payments[0].id}/void`))
      .set(auth())
      .send({ reason: 'Wrong amount' })
      .expect(200);

    const { rows } = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE organization_id = $1 AND entity_id = $2 AND action LIKE 'folio.%'
        ORDER BY created_at`,
      [orgId, reservationId],
    );
    expect(rows.map((row) => row.action)).toEqual([
      'folio.charge_posted',
      'folio.payment_recorded',
      'folio.payment_voided',
    ]);
  });

  it('will not serve a folio through a property it does not belong to', async () => {
    const { reservationId } = await book(NIGHTS[0], addDays(NIGHTS[0], 1));

    // 404 rather than 403: this caller is an organization-wide manager, so the
    // property in the path is one they MAY act on — there is simply no such
    // folio there. Answering 403 would imply the booking exists somewhere they
    // cannot see, which is the opposite of true.
    await request(app.getHttpServer())
      .get(`/api/v1/properties/${crypto.randomUUID()}/reservations/${reservationId}/folio`)
      .set(auth())
      .expect(404);
  });
});
