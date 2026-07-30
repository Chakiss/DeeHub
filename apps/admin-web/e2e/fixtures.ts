import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID, scrypt as scryptCb, randomBytes } from 'node:crypto';

/**
 * Test data for the dashboard end-to-end suite.
 *
 * Each run creates its OWN organization and tears it down afterwards, so the
 * suite can run against a shared development database without colliding with
 * seed data or with a developer's own experiments — and so a failure leaves
 * evidence in only its own rows.
 */

export const TEST_PASSWORD = 'dashboard-e2e-password';

export interface TestData {
  organizationId: string;
  organizationSlug: string;
  propertyId: string;
  roomTypeId: string;
  otherRoomTypeId: string;
  ratePlanId: string;
  managerEmail: string;
  frontDeskEmail: string;
  /** Dedicated to the change-password spec, which mutates its credential. */
  passwordUserEmail: string;
  dates: string[];
}

function connectionString(): string {
  return process.env['DATABASE_URL'] ?? 'postgresql://deehub:deehub@localhost:15432/deehub';
}

/**
 * Mirrors ScryptPasswordHasher exactly (ADR-0006). Duplicated rather than
 * imported because the dashboard package must not depend on the API's
 * internals — but if the API's parameters change, these logins will fail
 * loudly, which is the right signal.
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCb(
      password.normalize('NFKC'),
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 256 * 32768 * 8 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
  return ['scrypt', 32768, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');
}

export function testDataPath(): string {
  // Resolved from the working directory, not import.meta: Playwright transpiles
  // these files to CommonJS, where import.meta does not exist.
  return resolve(process.cwd(), 'e2e/.test-data.json');
}

export async function seed(): Promise<TestData> {
  const pool = new Pool({ connectionString: connectionString(), max: 2 });
  const organizationId = randomUUID();
  const short = organizationId.slice(0, 8);

  const data: TestData = {
    organizationId,
    organizationSlug: `e2e-${short}`,
    propertyId: randomUUID(),
    roomTypeId: randomUUID(),
    otherRoomTypeId: randomUUID(),
    ratePlanId: randomUUID(),
    managerEmail: `manager-${short}@e2e.test`,
    frontDeskEmail: `frontdesk-${short}@e2e.test`,
    passwordUserEmail: `password-${short}@e2e.test`,
    // Far future so these never collide with seed data or a real booking.
    dates: ['2030-04-01', '2030-04-02', '2030-04-03', '2030-04-04', '2030-04-05', '2030-04-06'],
  };

  try {
    const passwordHash = await hashPassword(TEST_PASSWORD);

    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      data.organizationId,
      'E2E Dashboard Org',
      data.organizationSlug,
    ]);

    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency,
                               tax_rate_bp, service_charge_rate_bp)
       VALUES ($1, $2, 'E2E1', 'E2E Test Resort', 'Asia/Bangkok', 'THB', 700, 1000)`,
      [data.propertyId, data.organizationId],
    );

    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children, sort_order)
       VALUES ($1, $2, $3, 'DLX', 'Deluxe Double', 2, 3, 3, 1, 0),
              ($4, $2, $3, 'STD', 'Standard Twin', 2, 2, 2, 0, 1)`,
      [data.roomTypeId, data.organizationId, data.propertyId, data.otherRoomTypeId],
    );

    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available Rate')`,
      [data.ratePlanId, data.organizationId, data.propertyId, data.roomTypeId],
    );

    for (const [email, role] of [
      [data.managerEmail, 'MANAGER'],
      [data.frontDeskEmail, 'FRONT_DESK'],
      [data.passwordUserEmail, 'MANAGER'],
    ] as const) {
      const userId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, data.organizationId, email, passwordHash, email],
      );
      await pool.query(
        `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), data.organizationId, userId, data.propertyId, role],
      );
    }

    // Only the Deluxe room type gets inventory. The Standard is deliberately
    // left with no rows, so the grid's "not open for sale" state is exercised.
    for (const date of data.dates) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 5, 0)`,
        [data.organizationId, data.propertyId, data.roomTypeId, date],
      );
      for (const occupancy of [1, 2]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 250000, 'THB')`,
          [data.organizationId, data.propertyId, data.ratePlanId, date, occupancy],
        );
      }
    }

    return data;
  } finally {
    await pool.end();
  }
}

export async function teardown(data: TestData): Promise<void> {
  const pool = new Pool({ connectionString: connectionString(), max: 2 });
  try {
    for (const table of [
      'outbox_events',
      'audit_logs',
      'reservations',
      'inventory_days',
      'rate_days',
      'rate_plans',
      'room_types',
      'memberships',
      'refresh_tokens',
      'users',
      'properties',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [data.organizationId]);
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [data.organizationId]);
  } finally {
    await pool.end();
  }
}
