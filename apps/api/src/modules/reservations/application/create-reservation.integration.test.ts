/**
 * End-to-end verification of the booking transaction (architecture.md §4).
 *
 * Runs the real use cases, real repositories and real PostgreSQL through the
 * real Nest DI graph — so it also proves the module wiring resolves.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import { toIsoDate, type IsoDate } from '@deehub/shared';

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. Booking-path tests must run against Postgres.');
}

// The API validates configuration at boot and refuses to start without these.
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-to-pass';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-to-pass';
process.env.REDIS_URL ??= 'redis://localhost:16379';

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('booking transaction', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let createReservation: import('./create-reservation.usecase').CreateReservationUseCase;
  let cancelReservation: import('./cancel-reservation.usecase').CancelReservationUseCase;
  let runWithTenant: typeof import('../../../common/tenant/tenant-context').runWithTenant;

  // Two organizations so tenant isolation can be tested for real.
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const roomTypeId = crypto.randomUUID();
  const otherRoomTypeId = crypto.randomUUID();
  const ratePlanId = crypto.randomUUID();
  const otherRatePlanId = crypto.randomUUID();

  const CHECK_IN = toIsoDate('2026-08-12');
  const CHECK_OUT = toIsoDate('2026-08-15');
  const NIGHTS: IsoDate[] = [
    toIsoDate('2026-08-12'),
    toIsoDate('2026-08-13'),
    toIsoDate('2026-08-14'),
  ];
  const HORIZON = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];
  const NIGHTLY_RATE = 250000; // ฿2,500.00

  const actor = { type: 'USER' as const, id: null, label: 'test-suite' };

  function tenant(organizationId = orgId) {
    return {
      organizationId,
      userId: null,
      propertyId,
      requestId: 'test-request',
    };
  }

  beforeAll(async () => {
    const { AppModule } = await import('../../../app.module');
    const { DATABASE_POOL } = await import('../../../database/database.module');
    const { CreateReservationUseCase } = await import('./create-reservation.usecase');
    const { CancelReservationUseCase } = await import('./cancel-reservation.usecase');
    const tenantContext = await import('../../../common/tenant/tenant-context');
    runWithTenant = tenantContext.runWithTenant;

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    pool = moduleRef.get<Pool>(DATABASE_POOL);
    createReservation = moduleRef.get(CreateReservationUseCase);
    cancelReservation = moduleRef.get(CancelReservationUseCase);

    for (const id of [orgId, otherOrgId]) {
      await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        'Booking Test Org',
        `booking-${id.slice(0, 8)}`,
      ]);
    }

    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency,
                               tax_rate_bp, service_charge_rate_bp, prices_include_tax)
       VALUES ($1, $2, $3, 'Booking Test Property', 'Asia/Bangkok', 'THB', 700, 1000, false)`,
      [propertyId, orgId, `P-${propertyId.slice(0, 6)}`],
    );

    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe Double', 2, 3, 2, 1),
              ($4, $2, $3, 'STD', 'Standard', 2, 2, 2, 0)`,
      [roomTypeId, orgId, propertyId, otherRoomTypeId],
    );

    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available Rate'),
              ($5, $2, $3, $6, 'BAR-STD', 'BAR Standard')`,
      [ratePlanId, orgId, propertyId, roomTypeId, otherRatePlanId, otherRoomTypeId],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM outbox_events WHERE organization_id = ANY($1)', [
      [orgId, otherOrgId],
    ]);
    await pool.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [
      [orgId, otherOrgId],
    ]);
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_plans WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM room_types WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM properties WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgId, otherOrgId]]);
    await moduleRef.close();
  });

  async function seed(
    options: {
      allotment?: number;
      perDate?: Record<string, Partial<{ allotment: number; stopSell: boolean; minStay: number }>>;
      rateDates?: readonly string[];
      occupancies?: readonly number[];
    } = {},
  ): Promise<void> {
    await pool.query('DELETE FROM reservations WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM inventory_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM rate_days WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]);

    for (const rt of [roomTypeId, otherRoomTypeId]) {
      for (const date of HORIZON) {
        const overrides = options.perDate?.[date] ?? {};
        await pool.query(
          `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date,
                                       allotment, booked, stop_sell, min_stay)
           VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
          [
            orgId,
            propertyId,
            rt,
            date,
            overrides.allotment ?? options.allotment ?? 5,
            overrides.stopSell ?? false,
            overrides.minStay ?? 1,
          ],
        );
      }
    }

    for (const [plan, rt] of [
      [ratePlanId, roomTypeId],
      [otherRatePlanId, otherRoomTypeId],
    ] as const) {
      void rt;
      for (const date of options.rateDates ?? HORIZON) {
        for (const occupancy of options.occupancies ?? [1, 2]) {
          await pool.query(
            `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                    occupancy, amount_minor, currency)
             VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
            [orgId, propertyId, plan, date, occupancy, NIGHTLY_RATE],
          );
        }
      }
    }
  }

  async function bookedOn(date: string, rt = roomTypeId): Promise<number> {
    const result = await pool.query<{ booked: number }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [rt, date],
    );
    return result.rows[0]?.booked ?? -1;
  }

  function oneStay(overrides: Record<string, unknown> = {}) {
    return {
      propertyId,
      source: 'WALK_IN' as const,
      booker: { name: 'Somchai Prasert', email: 's@example.com' },
      stays: [
        {
          roomTypeId,
          ratePlanId,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          adults: 2,
          children: 0,
        },
      ],
      ...overrides,
    };
  }

  beforeEach(async () => {
    await seed();
  });

  describe('happy path', () => {
    it('creates a reservation, holds inventory and snapshots per-night prices', async () => {
      const result = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      expect(result.code).toMatch(/^DH-[A-Z0-9]{6}$/);
      expect(result.status).toBe('CONFIRMED');

      // Thai order: room, then 10% service charge, then 7% VAT on the sum.
      expect(result.subtotal.amount).toBe(750000);
      expect(result.serviceCharge.amount).toBe(75000);
      expect(result.tax.amount).toBe(57750);
      expect(result.total.amount).toBe(882750);

      for (const night of NIGHTS) {
        expect(await bookedOn(night)).toBe(1);
      }
      // The departure date is not a night and must not be held.
      expect(await bookedOn('2026-08-15')).toBe(0);

      const nights = await pool.query<{ amount_minor: string; date: string }>(
        `SELECT date, amount_minor FROM reservation_stay_nights
          WHERE reservation_id = $1 ORDER BY date`,
        [result.id],
      );
      expect(nights.rows).toHaveLength(3);
      expect(nights.rows.map((r) => Number(r.amount_minor))).toEqual([
        NIGHTLY_RATE,
        NIGHTLY_RATE,
        NIGHTLY_RATE,
      ]);
    });

    it('freezes prices so later rate changes do not rewrite the booking', async () => {
      const result = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      await pool.query(
        `UPDATE rate_days SET amount_minor = 999999
          WHERE rate_plan_id = $1 AND organization_id = $2`,
        [ratePlanId, orgId],
      );

      const nights = await pool.query<{ amount_minor: string }>(
        'SELECT amount_minor FROM reservation_stay_nights WHERE reservation_id = $1',
        [result.id],
      );
      for (const row of nights.rows) {
        expect(Number(row.amount_minor)).toBe(NIGHTLY_RATE);
      }
    });

    it('writes the audit entry and outbox events in the same transaction', async () => {
      const result = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      const audit = await pool.query<{ action: string }>(
        'SELECT action FROM audit_logs WHERE entity_id = $1',
        [result.id],
      );
      expect(audit.rows.map((r) => r.action)).toContain('reservation.created');

      const outbox = await pool.query<{ event_type: string; published_at: string | null }>(
        'SELECT event_type, published_at FROM outbox_events WHERE organization_id = $1',
        [orgId],
      );
      const types = outbox.rows.map((r) => r.event_type);
      expect(types).toContain('reservation.created');
      // The channel manager needs to know availability changed.
      expect(types).toContain('inventory.changed');
      // Unpublished: the relay picks them up after commit.
      expect(outbox.rows.every((r) => r.published_at === null)).toBe(true);
    });

    it('treats two rooms of the same type as two stays holding two units', async () => {
      const result = await runWithTenant(tenant(), () =>
        createReservation.execute(
          oneStay({
            stays: [
              { roomTypeId, ratePlanId, checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: 2 },
              { roomTypeId, ratePlanId, checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: 2 },
            ],
          }),
          actor,
        ),
      );

      expect(result.stays).toHaveLength(2);
      expect(result.total.amount).toBe(882750 * 2);
      for (const night of NIGHTS) {
        expect(await bookedOn(night)).toBe(2);
      }
    });

    it('creates a PENDING hold with an expiry', async () => {
      const result = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay({ status: 'PENDING', holdTtlSeconds: 60 }), actor),
      );
      expect(result.status).toBe('PENDING');

      const row = await pool.query<{ hold_expires_at: Date }>(
        'SELECT hold_expires_at FROM reservations WHERE id = $1',
        [result.id],
      );
      expect(row.rows[0]?.hold_expires_at).toBeInstanceOf(Date);
      // A hold still consumes inventory while it is alive.
      expect(await bookedOn(NIGHTS[0] as string)).toBe(1);
    });
  });

  describe('rejections leave no trace', () => {
    it('rolls back EVERY stay when a later stay is unavailable', async () => {
      // The killer case: stay 1 succeeds, stay 2 hits a sold-out night. If the
      // transaction leaked, stay 1's nights would stay consumed by a
      // reservation that was never created.
      await seed({ perDate: { '2026-08-13': { allotment: 0 } } });

      await expect(
        runWithTenant(tenant(), () =>
          createReservation.execute(
            oneStay({
              stays: [
                {
                  roomTypeId,
                  ratePlanId,
                  checkIn: CHECK_IN,
                  checkOut: toIsoDate('2026-08-13'),
                  adults: 2,
                },
                { roomTypeId, ratePlanId, checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: 2 },
              ],
            }),
            actor,
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVENTORY_UNAVAILABLE' });

      for (const night of NIGHTS) {
        expect(await bookedOn(night)).toBe(0);
      }
      const count = await pool.query('SELECT 1 FROM reservations WHERE organization_id = $1', [
        orgId,
      ]);
      expect(count.rowCount).toBe(0);
      // No phantom event may reach the OTAs.
      const outbox = await pool.query('SELECT 1 FROM outbox_events WHERE organization_id = $1', [
        orgId,
      ]);
      expect(outbox.rowCount).toBe(0);
    });

    it('rejects a stop-sell night with a typed restriction error', async () => {
      await seed({ perDate: { '2026-08-13': { stopSell: true } } });
      await expect(
        runWithTenant(tenant(), () => createReservation.execute(oneStay(), actor)),
      ).rejects.toMatchObject({
        code: 'RESTRICTION_VIOLATED',
        details: { restriction: 'STOP_SELL' },
      });
      expect(await bookedOn(NIGHTS[0] as string)).toBe(0);
    });

    it('rejects a stay shorter than the arrival night minimum', async () => {
      await seed({ perDate: { '2026-08-12': { minStay: 5 } } });
      await expect(
        runWithTenant(tenant(), () => createReservation.execute(oneStay(), actor)),
      ).rejects.toMatchObject({
        code: 'RESTRICTION_VIOLATED',
        details: { restriction: 'MIN_STAY', required: 5, requested: 3 },
      });
    });

    it('refuses to sell a night that has no configured rate', async () => {
      await seed({ rateDates: ['2026-08-12', '2026-08-14'] }); // 13th missing
      await expect(
        runWithTenant(tenant(), () => createReservation.execute(oneStay(), actor)),
      ).rejects.toMatchObject({
        code: 'RATE_MISSING',
        details: { missingDates: ['2026-08-13'] },
      });
      // Crucially, no inventory was consumed for a booking we could not price.
      expect(await bookedOn(NIGHTS[0] as string)).toBe(0);
    });

    it('refuses a night that was never opened for sale', async () => {
      await pool.query('DELETE FROM inventory_days WHERE room_type_id = $1 AND date = $2', [
        roomTypeId,
        '2026-08-13',
      ]);
      await expect(
        runWithTenant(tenant(), () => createReservation.execute(oneStay(), actor)),
      ).rejects.toMatchObject({ code: 'INVENTORY_UNAVAILABLE' });
    });

    it('enforces room-type occupancy limits', async () => {
      await expect(
        runWithTenant(tenant(), () =>
          createReservation.execute(
            oneStay({
              stays: [
                { roomTypeId, ratePlanId, checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: 3 },
              ],
            }),
            actor,
          ),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('refuses a rate plan belonging to a different room type', async () => {
      await expect(
        runWithTenant(tenant(), () =>
          createReservation.execute(
            oneStay({
              stays: [
                {
                  roomTypeId,
                  ratePlanId: otherRatePlanId,
                  checkIn: CHECK_IN,
                  checkOut: CHECK_OUT,
                  adults: 2,
                },
              ],
            }),
            actor,
          ),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an empty reservation', async () => {
      await expect(
        runWithTenant(tenant(), () => createReservation.execute(oneStay({ stays: [] }), actor)),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('tenant isolation', () => {
    it('cannot book another organization property, and says NOT_FOUND not FORBIDDEN', async () => {
      await expect(
        runWithTenant(tenant(otherOrgId), () => createReservation.execute(oneStay(), actor)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses to run without a tenant scope at all', async () => {
      await expect(createReservation.execute(oneStay(), actor)).rejects.toThrow(
        /No tenant context/,
      );
    });
  });

  describe('cancellation', () => {
    it('releases every night when cancelled before arrival', async () => {
      const created = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      const result = await runWithTenant(tenant(), () =>
        cancelReservation.execute(
          { reservationId: created.id, expectedVersion: 0, reason: 'Guest changed plans' },
          actor,
          new Date('2026-08-01T03:00:00Z'), // well before check-in
        ),
      );

      expect(result.releasedNights).toEqual(NIGHTS);
      expect(result.retainedNights).toEqual([]);
      for (const night of NIGHTS) {
        expect(await bookedOn(night)).toBe(0);
      }
    });

    it('retains nights already consumed when cancelled mid-stay', async () => {
      // The business rule flagged in domain-model.md §3.5: a guest who checked
      // in on the 12th and leaves early on the 14th DID occupy the 12th and
      // 13th. Releasing those would claim the hotel had rooms free on nights
      // it did not.
      const created = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      // 2026-08-14 07:00 Bangkok time.
      const midStay = new Date('2026-08-14T00:00:00Z');

      const result = await runWithTenant(tenant(), () =>
        cancelReservation.execute(
          { reservationId: created.id, expectedVersion: 0, reason: 'Early departure' },
          actor,
          midStay,
        ),
      );

      expect(result.retainedNights).toEqual(['2026-08-12', '2026-08-13']);
      expect(result.releasedNights).toEqual(['2026-08-14']);

      expect(await bookedOn('2026-08-12')).toBe(1);
      expect(await bookedOn('2026-08-13')).toBe(1);
      expect(await bookedOn('2026-08-14')).toBe(0);
    });

    it('uses the property timezone to decide the business date', async () => {
      const created = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      // 2026-08-12 18:00 UTC is already the 13th in Bangkok (UTC+7), so the
      // night of the 12th counts as consumed.
      const result = await runWithTenant(tenant(), () =>
        cancelReservation.execute(
          { reservationId: created.id, expectedVersion: 0 },
          actor,
          new Date('2026-08-12T18:00:00Z'),
        ),
      );

      expect(result.retainedNights).toEqual(['2026-08-12']);
      expect(result.releasedNights).toEqual(['2026-08-13', '2026-08-14']);
    });

    it('rejects a stale version instead of overwriting', async () => {
      const created = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      await expect(
        runWithTenant(tenant(), () =>
          cancelReservation.execute({ reservationId: created.id, expectedVersion: 7 }, actor),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });

      // Nothing was released.
      expect(await bookedOn(NIGHTS[0] as string)).toBe(1);
    });

    it('refuses to cancel twice', async () => {
      const created = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      await runWithTenant(tenant(), () =>
        cancelReservation.execute(
          { reservationId: created.id, expectedVersion: 0 },
          actor,
          new Date('2026-08-01T03:00:00Z'),
        ),
      );

      await expect(
        runWithTenant(tenant(), () =>
          cancelReservation.execute({ reservationId: created.id, expectedVersion: 1 }, actor),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('emits cancellation and inventory events', async () => {
      const created = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );
      await pool.query('DELETE FROM outbox_events WHERE organization_id = $1', [orgId]);

      await runWithTenant(tenant(), () =>
        cancelReservation.execute(
          { reservationId: created.id, expectedVersion: 0 },
          actor,
          new Date('2026-08-01T03:00:00Z'),
        ),
      );

      const outbox = await pool.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_events WHERE organization_id = $1',
        [orgId],
      );
      const types = outbox.rows.map((r) => r.event_type);
      expect(types).toContain('reservation.cancelled');
      expect(types).toContain('inventory.changed');
    });

    it('frees the room for someone else to book', async () => {
      await seed({ allotment: 1 });

      const first = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );

      // Sold out.
      await expect(
        runWithTenant(tenant(), () => createReservation.execute(oneStay(), actor)),
      ).rejects.toMatchObject({ code: 'INVENTORY_UNAVAILABLE' });

      await runWithTenant(tenant(), () =>
        cancelReservation.execute(
          { reservationId: first.id, expectedVersion: 0 },
          actor,
          new Date('2026-08-01T03:00:00Z'),
        ),
      );

      const second = await runWithTenant(tenant(), () =>
        createReservation.execute(oneStay(), actor),
      );
      expect(second.id).not.toBe(first.id);
      expect(await bookedOn(NIGHTS[0] as string)).toBe(1);
    });
  });
});
