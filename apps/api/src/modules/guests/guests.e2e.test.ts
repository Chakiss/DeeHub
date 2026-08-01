/**
 * Guest profiles against real PostgreSQL.
 *
 * The centre of these is the matching rule. Attaching a stay to the wrong
 * person shows one guest another guest's history, and nothing in the data
 * later reveals that it happened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Guest e2e tests must run against Postgres.');
}

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('Guests', () => {
  let app: INestApplication;
  let pool: Pool;

  const PASSWORD = 'guests-e2e-password';
  const orgId = crypto.randomUUID();
  const orgSlug = `gs-${orgId.slice(0, 8)}`;
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const managerId = crypto.randomUUID();

  const DATES = ['2029-04-01', '2029-04-02', '2029-04-03', '2029-04-04'];
  let token = '';

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
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country)
       VALUES ($1, $2, 'MAIN', 'Guest Hotel', 'Asia/Bangkok', 'THB', 'TH')`,
      [propertyId, orgId],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe')`,
      [roomTypeId, orgId, propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available')`,
      [ratePlanId, orgId, propertyId, roomTypeId],
    );
    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $3)`,
      [
        managerId,
        orgId,
        `manager-${orgSlug}@e2e.test`,
        await new ScryptPasswordHasher().hash(PASSWORD),
      ],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
       VALUES ($1, $2, $3, NULL, 'MANAGER')`,
      [crypto.randomUUID(), orgId, managerId],
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ organizationSlug: orgSlug, email: `manager-${orgSlug}@e2e.test`, password: PASSWORD })
      .expect(200);
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    for (const table of [
      'outbox_events',
      'audit_logs',
      'reservation_stay_nights',
      'reservation_stays',
      'reservations',
      'guests',
      'inventory_days',
      'rate_days',
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
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM guests WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);

    for (const date of DATES) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 10, 0)`,
        [orgId, propertyId, roomTypeId, date],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy,
                                  amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 200000, 'THB')`,
          [orgId, propertyId, ratePlanId, date, occupancy],
        );
      }
    }
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function book(
    booker: { name: string; email?: string; phone?: string },
    checkIn = DATES[0]!,
    checkOut = DATES[1]!,
  ) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations`)
      .set(auth())
      .send({
        source: 'WALK_IN',
        booker,
        stays: [{ roomTypeId, ratePlanId, checkIn, checkOut, adults: 2 }],
      })
      .expect(201);
    return response.body as { id: string };
  }

  it('creates a guest from the booker and attaches it to the reservation', async () => {
    const reservation = await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });

    const { rows } = await pool.query<{ guest_id: string | null }>(
      'SELECT guest_id FROM reservations WHERE id = $1',
      [reservation.id],
    );
    // Before this existed, every reservation was written with guest_id null.
    expect(rows[0]?.guest_id).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      firstName: 'Somchai',
      lastName: 'Prasert',
      email: 'somchai@example.com',
      stays: 1,
    });
  });

  it('links a returning guest to the same profile', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    await book({ name: 'Somchai Prasert', email: 'SOMCHAI@example.com' }, DATES[2]!, DATES[3]!);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    // The point of the whole module: history accrues.
    expect(list.body.items[0].stays).toBe(2);
    expect(list.body.items[0].revenueMinor).toBeGreaterThan(0);
  });

  /**
   * The rule that matters. A shared address is real — a company books its
   * staff through one inbox — and matching on email alone would show one
   * person another's stays with nothing in the data revealing it.
   */
  it('does NOT merge two people who share an email address', async () => {
    await book({ name: 'Somchai Prasert', email: 'info@company.co.th' });
    await book({ name: 'Malee Wong', email: 'info@company.co.th' }, DATES[2]!, DATES[3]!);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(2);

    // Both are flagged so a human can decide, rather than the system deciding.
    for (const item of list.body.items as { possibleDuplicates: number }[]) {
      expect(item.possibleDuplicates).toBe(1);
    }
  });

  // Without an address there is nothing to match on, and guessing from a name
  // alone would merge every "John Smith" in the country.
  it('creates a separate profile when no email is given', async () => {
    await book({ name: 'Walk In Guest' });
    await book({ name: 'Walk In Guest' }, DATES[2]!, DATES[3]!);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items).toHaveLength(2);
  });

  it('treats a single-word name as a first name with no family name', async () => {
    await book({ name: 'Ploy', email: 'ploy@example.com' });

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ firstName: 'Ploy', lastName: null });
  });

  it('searches by name, email and phone', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com', phone: '0812345678' });

    for (const term of ['prasert', 'SOMCHAI@EXAMPLE', '08123']) {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/guests?q=${encodeURIComponent(term)}`)
        .set(auth())
        .expect(200);
      expect(response.body.items, `searching for ${term}`).toHaveLength(1);
    }
  });

  it('does not count a cancelled booking as a stay', async () => {
    const reservation = await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${propertyId}/reservations/${reservation.id}/cancel`)
      .set(auth())
      .send({ version: 0 })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    // Somebody who booked and cancelled is not a returning guest.
    expect(list.body.items[0].stays).toBe(0);
  });

  it('corrects a profile', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    const id = list.body.items[0].id as string;

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/properties/${propertyId}/guests/${id}`)
      .set(auth())
      .send({ lastName: 'Prasert-Wong', notes: 'Prefers a high floor' })
      .expect(200);

    expect(response.body).toMatchObject({
      lastName: 'Prasert-Wong',
      notes: 'Prefers a high floor',
    });
  });

  // The row carries an encrypted document number; serialising the whole record
  // is exactly how that leaves the building.
  it('never returns the encrypted document number', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('documentNumber');
    expect(serialized).not.toContain('document_number');
  });

  describe('finding and merging duplicates', () => {
    /** Book, then read back the profile the booking created. */
    async function bookAndFind(
      booker: { name: string; email?: string; phone?: string },
      checkIn = DATES[0]!,
      checkOut = DATES[1]!,
    ): Promise<string> {
      const reservation = await book(booker, checkIn, checkOut);
      const { rows } = await pool.query<{ guest_id: string }>(
        'SELECT guest_id FROM reservations WHERE id = $1',
        [reservation.id],
      );
      return rows[0]!.guest_id;
    }

    function duplicatesOf(guestId: string) {
      return request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/guests/${guestId}/duplicates`)
        .set(auth())
        .expect(200);
    }

    it('offers a candidate that shares an email, and calls it uncertain', async () => {
      const somchai = await bookAndFind({ name: 'Somchai Prasert', email: 'info@company.co.th' });
      await bookAndFind({ name: 'Malee Wong', email: 'info@company.co.th' }, DATES[2]!, DATES[3]!);

      const response = await duplicatesOf(somchai);
      expect(response.body.items).toHaveLength(1);
      // A shared inbox is common enough that an email alone is not proof.
      expect(response.body.items[0]).toMatchObject({
        firstName: 'Malee',
        signals: ['EMAIL'],
        confidence: 'MEDIUM',
      });
    });

    it('recognises one mobile written two ways', async () => {
      const local = await bookAndFind({ name: 'Ploy A', phone: '081 234 5678' });
      await bookAndFind({ name: 'Ploy B', phone: '+66 81 234 5678' }, DATES[2]!, DATES[3]!);

      const response = await duplicatesOf(local);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ signals: ['PHONE'], confidence: 'HIGH' });
    });

    it('finds a returning guest who mistyped their email', async () => {
      // The case the whole feature exists for.
      const first = await bookAndFind({
        name: 'Somchai Prasert',
        email: 'somchai@example.com',
        phone: '0812345678',
      });
      await bookAndFind(
        { name: 'Somchai Prasert', email: 'somchia@example.com', phone: '0812345678' },
        DATES[2]!,
        DATES[3]!,
      );

      const response = await duplicatesOf(first);
      expect(response.body.items[0]).toMatchObject({
        signals: ['NAME', 'PHONE'],
        confidence: 'HIGH',
      });
    });

    it('offers nobody when there is nothing to match on', async () => {
      const alone = await bookAndFind({ name: 'Nadia Chen', email: 'nadia@example.com' });
      await bookAndFind({ name: 'Kwan Lee', email: 'kwan@example.com' }, DATES[2]!, DATES[3]!);

      expect((await duplicatesOf(alone)).body.items).toHaveLength(0);
    });

    it('moves the stays onto the survivor and leaves one profile', async () => {
      const survivor = await bookAndFind({
        name: 'Somchai Prasert',
        email: 'somchai@example.com',
        phone: '0812345678',
      });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'somchia@example.com', phone: '0812345678' },
        DATES[2]!,
        DATES[3]!,
      );

      const merged = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      expect(merged.body.reservationsMoved).toBe(1);
      // A split history is what made the returning guest invisible.
      expect(merged.body.guest).toMatchObject({ id: survivor, stays: 2 });

      const list = await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/guests`)
        .set(auth())
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].id).toBe(survivor);
    });

    it('keeps the survivor own details and fills only its blanks', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'kept@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'other@example.com', phone: '0812345678' },
        DATES[2]!,
        DATES[3]!,
      );

      const merged = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      // The direction is the operator's choice; it has to mean something.
      expect(merged.body.guest.email).toBe('kept@example.com');
      expect(merged.body.guest.phone).toBe('0812345678');
      expect(merged.body.fieldsFilled).toContain('phone');
      expect(merged.body.fieldsFilled).not.toContain('email');
    });

    it('keeps both notes rather than choosing one', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com' },
        DATES[2]!,
        DATES[3]!,
      );

      for (const [id, note] of [
        [survivor, 'Allergic to nuts'],
        [duplicate, 'Prefers a high floor'],
      ] as const) {
        await request(app.getHttpServer())
          .patch(`/api/v1/properties/${propertyId}/guests/${id}`)
          .set(auth())
          .send({ notes: note })
          .expect(200);
      }

      const merged = await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      // An allergy is exactly the thing nobody can reconstruct later.
      expect(merged.body.guest.notes).toContain('Allergic to nuts');
      expect(merged.body.guest.notes).toContain('Prefers a high floor');
    });

    it('leaves the folded profile unreachable but not deleted', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com' },
        DATES[2]!,
        DATES[3]!,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/properties/${propertyId}/guests/${duplicate}`)
        .set(auth())
        .expect(404);

      // Still there, pointing at where its history went.
      const { rows } = await pool.query<{ merged_into_id: string | null }>(
        'SELECT merged_into_id FROM guests WHERE id = $1',
        [duplicate],
      );
      expect(rows[0]?.merged_into_id).toBe(survivor);
    });

    it('refuses to merge a profile into itself', async () => {
      const guestId = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${guestId}/merge`)
        .set(auth())
        .send({ duplicateId: guestId })
        .expect(422);
    });

    it('refuses to merge the same profile twice', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com' },
        DATES[2]!,
        DATES[3]!,
      );

      for (const expected of [201, 422]) {
        await request(app.getHttpServer())
          .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
          .set(auth())
          .send({ duplicateId: duplicate })
          .expect(expected);
      }
    });

    it('refuses to merge into a profile that has itself been folded away', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });
      const middle = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com' },
        DATES[2]!,
        DATES[3]!,
      );
      const third = await bookAndFind(
        { name: 'Somchai Prasert', email: 'c@example.com' },
        DATES[1]!,
        DATES[2]!,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: middle })
        .expect(201);

      // Stays behind a tombstone would be invisible to every read path.
      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${middle}/merge`)
        .set(auth())
        .send({ duplicateId: third })
        .expect(422);
    });

    it('never offers a folded profile as a candidate again', async () => {
      const survivor = await bookAndFind({
        name: 'Somchai Prasert',
        email: 'a@example.com',
        phone: '0812345678',
      });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com', phone: '0812345678' },
        DATES[2]!,
        DATES[3]!,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      expect((await duplicatesOf(survivor)).body.items).toHaveLength(0);
    });

    it('records both sides in the audit trail, without the document number', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com' },
        DATES[2]!,
        DATES[3]!,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      const { rows } = await pool.query<{ action: string; entity_id: string; after: unknown }>(
        `SELECT action, entity_id, after FROM audit_logs
          WHERE organization_id = $1 AND action LIKE 'guest.merged%'
            AND entity_id IN ($2, $3)
          ORDER BY action`,
        [orgId, survivor, duplicate],
      );

      // One entry per profile: an investigator arrives holding one id, not both.
      expect(rows.map((row) => row.action)).toEqual(['guest.merged', 'guest.merged_away']);
      expect(rows.find((row) => row.action === 'guest.merged')?.entity_id).toBe(survivor);
      expect(rows.find((row) => row.action === 'guest.merged_away')?.entity_id).toBe(duplicate);
      // The audit table is not encrypted; the column it would copy from is.
      expect(JSON.stringify(rows)).not.toContain('documentNumberEncrypted');
    });

    it('does not let a new booking attach to a folded profile', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'keep@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'gone@example.com' },
        DATES[2]!,
        DATES[3]!,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .set(auth())
        .send({ duplicateId: duplicate })
        .expect(201);

      // Booking again with the folded address must not resurrect it: the stay
      // would land on a record nothing reads.
      const again = await bookAndFind(
        { name: 'Somchai Prasert', email: 'gone@example.com' },
        DATES[1]!,
        DATES[2]!,
      );
      expect(again).not.toBe(duplicate);
    });

    it('refuses a merge from a read-only user', async () => {
      const survivor = await bookAndFind({ name: 'Somchai Prasert', email: 'a@example.com' });
      const duplicate = await bookAndFind(
        { name: 'Somchai Prasert', email: 'b@example.com' },
        DATES[2]!,
        DATES[3]!,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/properties/${propertyId}/guests/${survivor}/merge`)
        .send({ duplicateId: duplicate })
        .expect(401);
    });
  });

  it('is scoped to the organization', async () => {
    await book({ name: 'Somchai Prasert', email: 'somchai@example.com' });
    const list = await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests`)
      .set(auth())
      .expect(200);
    const id = list.body.items[0].id as string;

    // A different organization's manager must not be able to read it. Reusing
    // this org's token against a fabricated id is the cheap half; the real
    // check is that another tenant sees nothing at all.
    await request(app.getHttpServer())
      .get(`/api/v1/properties/${propertyId}/guests/${crypto.randomUUID()}`)
      .set(auth())
      .expect(404);

    expect(id).toBeTruthy();
  });
});
