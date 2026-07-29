/**
 * The most important test in the product.
 *
 * Proves the anti-overbooking guarantee of ADR-0002 against a real
 * PostgreSQL, at both layers:
 *   1. the CHECK constraint, which holds even when application code is wrong;
 *   2. the guarded UPDATE, which resolves concurrent bookings correctly.
 *
 * Requires DATABASE_URL (docker compose + pnpm db:migrate). Skipped when unset
 * so a fresh clone can still run unit tests; CI always sets it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

const connectionString = process.env.DATABASE_URL;

// Skipping locally is a convenience; skipping in CI would mean the overbooking
// guarantee ships unverified. Fail loudly instead.
if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. The inventory guard tests must run against a real ' +
      'PostgreSQL — a skipped run proves nothing about overbooking.',
  );
}

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('inventory overbooking guard', () => {
  let pool: Pool;
  const orgId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();
  const NIGHT_1 = '2026-08-12';
  const NIGHT_2 = '2026-08-13';

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 6 });

    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [
      orgId,
      'Guard Test Org',
      `guard-${orgId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency)
       VALUES ($1, $2, $3, $4, 'Asia/Bangkok', 'THB')`,
      [propertyId, orgId, `P-${propertyId.slice(0, 6)}`, 'Guard Test Property'],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe Double')`,
      [roomTypeId, orgId, propertyId],
    );
  });

  afterAll(async () => {
    // Ordered by dependency; the schema uses ON DELETE RESTRICT deliberately.
    await pool.query(`DELETE FROM inventory_days WHERE room_type_id = $1`, [roomTypeId]);
    await pool.query(`DELETE FROM room_types WHERE id = $1`, [roomTypeId]);
    await pool.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  /** Reset both nights to a known allotment with nothing sold. */
  async function seedInventory(night1Allotment: number, night2Allotment: number): Promise<void> {
    await pool.query(`DELETE FROM inventory_days WHERE room_type_id = $1`, [roomTypeId]);
    await pool.query(
      `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
       VALUES ($1, $2, $3, $4, $5, 0), ($1, $2, $3, $6, $7, 0)`,
      [orgId, propertyId, roomTypeId, NIGHT_1, night1Allotment, NIGHT_2, night2Allotment],
    );
  }

  async function bookedOn(date: string): Promise<number> {
    const result = await pool.query<{ booked: number }>(
      `SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2`,
      [roomTypeId, date],
    );
    return result.rows[0]?.booked ?? -1;
  }

  /**
   * The documented booking guard (database.md §11.1): lock in date order, then
   * increment only where capacity allows, and require every night to succeed.
   */
  async function attemptBooking(
    client: PoolClient,
    dates: readonly string[],
    units = 1,
  ): Promise<'BOOKED' | 'REJECTED'> {
    await client.query('BEGIN');
    try {
      await client.query(
        `SELECT room_type_id, date FROM inventory_days
          WHERE room_type_id = $1 AND date = ANY($2::date[])
          ORDER BY date
            FOR UPDATE`,
        [roomTypeId, dates],
      );

      const updated = await client.query(
        `UPDATE inventory_days
            SET booked = booked + $3, updated_at = now()
          WHERE room_type_id = $1 AND date = ANY($2::date[])
            AND booked + $3 <= allotment`,
        [roomTypeId, dates, units],
      );

      if (updated.rowCount !== dates.length) {
        await client.query('ROLLBACK');
        return 'REJECTED';
      }
      await client.query('COMMIT');
      return 'BOOKED';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  beforeEach(async () => {
    await seedInventory(1, 1);
  });

  it('CHECK constraint refuses booked > allotment even for a direct write', async () => {
    // Defense in depth: this bypasses the guarded UPDATE entirely, simulating
    // a bug or a careless manual fix in production.
    await expect(
      pool.query(`UPDATE inventory_days SET booked = 5 WHERE room_type_id = $1 AND date = $2`, [
        roomTypeId,
        NIGHT_1,
      ]),
    ).rejects.toThrow(/inventory_booked_range_ck/);

    expect(await bookedOn(NIGHT_1)).toBe(0);
  });

  it('CHECK constraint refuses negative booked', async () => {
    await expect(
      pool.query(`UPDATE inventory_days SET booked = -1 WHERE room_type_id = $1 AND date = $2`, [
        roomTypeId,
        NIGHT_1,
      ]),
    ).rejects.toThrow(/inventory_booked_range_ck/);
  });

  it('CHECK constraint refuses lowering allotment below what is already sold', async () => {
    const client = await pool.connect();
    try {
      expect(await attemptBooking(client, [NIGHT_1])).toBe('BOOKED');
    } finally {
      client.release();
    }

    await expect(
      pool.query(`UPDATE inventory_days SET allotment = 0 WHERE room_type_id = $1 AND date = $2`, [
        roomTypeId,
        NIGHT_1,
      ]),
    ).rejects.toThrow(/inventory_booked_range_ck/);
  });

  it('books the last available room exactly once', async () => {
    const client = await pool.connect();
    try {
      expect(await attemptBooking(client, [NIGHT_1])).toBe('BOOKED');
      expect(await bookedOn(NIGHT_1)).toBe(1);
      // Second attempt on a sold-out night is rejected, not queued or oversold.
      expect(await attemptBooking(client, [NIGHT_1])).toBe('REJECTED');
      expect(await bookedOn(NIGHT_1)).toBe(1);
    } finally {
      client.release();
    }
  });

  it('lets exactly one of two CONCURRENT bookings win the last room', async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      // A locks the night first.
      await clientA.query('BEGIN');
      await clientA.query(
        `SELECT date FROM inventory_days
          WHERE room_type_id = $1 AND date = ANY($2::date[]) ORDER BY date FOR UPDATE`,
        [roomTypeId, [NIGHT_1]],
      );

      // B starts its lock and BLOCKS behind A. Deliberately not awaited yet.
      await clientB.query('BEGIN');
      const bLock = clientB.query(
        `SELECT date FROM inventory_days
          WHERE room_type_id = $1 AND date = ANY($2::date[]) ORDER BY date FOR UPDATE`,
        [roomTypeId, [NIGHT_1]],
      );

      // A takes the room and commits, releasing the lock.
      const aUpdate = await clientA.query(
        `UPDATE inventory_days SET booked = booked + 1
          WHERE room_type_id = $1 AND date = ANY($2::date[]) AND booked + 1 <= allotment`,
        [roomTypeId, [NIGHT_1]],
      );
      expect(aUpdate.rowCount).toBe(1);
      await clientA.query('COMMIT');

      // B now proceeds and sees the committed state.
      await bLock;
      const bUpdate = await clientB.query(
        `UPDATE inventory_days SET booked = booked + 1
          WHERE room_type_id = $1 AND date = ANY($2::date[]) AND booked + 1 <= allotment`,
        [roomTypeId, [NIGHT_1]],
      );
      // The guard bites: no rows matched, so B must roll back.
      expect(bUpdate.rowCount).toBe(0);
      await clientB.query('ROLLBACK');

      expect(await bookedOn(NIGHT_1)).toBe(1);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('survives a burst of parallel bookings without overselling', async () => {
    await seedInventory(3, 3);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const client = await pool.connect();
        try {
          return await attemptBooking(client, [NIGHT_1, NIGHT_2]);
        } finally {
          client.release();
        }
      }),
    );

    const booked = attempts.filter((outcome) => outcome === 'BOOKED').length;
    // Exactly the allotment sells; the rest are cleanly rejected.
    expect(booked).toBe(3);
    expect(attempts.filter((o) => o === 'REJECTED').length).toBe(7);
    expect(await bookedOn(NIGHT_1)).toBe(3);
    expect(await bookedOn(NIGHT_2)).toBe(3);
  });

  it('rejects a multi-night stay atomically when only one night is available', async () => {
    // Night 1 open, night 2 sold out: the stay must fail as a whole and leave
    // NO partial hold behind, or we would silently consume a night for a
    // booking that was never created.
    await seedInventory(1, 0);

    const client = await pool.connect();
    try {
      expect(await attemptBooking(client, [NIGHT_1, NIGHT_2])).toBe('REJECTED');
    } finally {
      client.release();
    }

    expect(await bookedOn(NIGHT_1)).toBe(0);
    expect(await bookedOn(NIGHT_2)).toBe(0);
  });

  it('rejects a stay whose nights are not all open for sale', async () => {
    // A missing inventory row means "not opened", never "unlimited".
    await pool.query(`DELETE FROM inventory_days WHERE room_type_id = $1 AND date = $2`, [
      roomTypeId,
      NIGHT_2,
    ]);

    const client = await pool.connect();
    try {
      expect(await attemptBooking(client, [NIGHT_1, NIGHT_2])).toBe('REJECTED');
    } finally {
      client.release();
    }

    expect(await bookedOn(NIGHT_1)).toBe(0);
  });

  it('books a multi-unit stay only when every night has capacity', async () => {
    await seedInventory(2, 2);
    const client = await pool.connect();
    try {
      expect(await attemptBooking(client, [NIGHT_1, NIGHT_2], 2)).toBe('BOOKED');
      expect(await attemptBooking(client, [NIGHT_1, NIGHT_2], 1)).toBe('REJECTED');
    } finally {
      client.release();
    }
    expect(await bookedOn(NIGHT_1)).toBe(2);
    expect(await bookedOn(NIGHT_2)).toBe(2);
  });
});
