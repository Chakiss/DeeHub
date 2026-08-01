import { Pool } from 'pg';
import { resolve } from 'node:path';
import { createHash, randomUUID, scrypt as scryptCb, randomBytes } from 'node:crypto';

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
  /** Dedicated to the password-reset spec, which also mutates its credential. */
  recoveryUserEmail: string;
  /**
   * Genuinely read-only. Front desk is NOT a stand-in for this: it holds
   * `guest:update` and several other write capabilities, so a spec that used
   * it to prove "no editing controls" would be asserting the wrong thing on
   * any screen a receptionist is meant to be able to change.
   */
  readOnlyEmail: string;
  /**
   * Organization-wide OWNER. Every other fixture user is scoped to a property,
   * which deliberately confers no authority over other people.
   */
  ownerEmail: string;
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
    recoveryUserEmail: `recovery-${short}@e2e.test`,
    readOnlyEmail: `readonly-${short}@e2e.test`,
    ownerEmail: `owner-${short}@e2e.test`,
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
      [data.recoveryUserEmail, 'MANAGER'],
      [data.readOnlyEmail, 'READ_ONLY'],
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

    // Organization-wide (propertyId NULL), so this one can administer people.
    const ownerId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $3)`,
      [ownerId, data.organizationId, data.ownerEmail, passwordHash],
    );
    await pool.query(
      `INSERT INTO memberships (id, organization_id, user_id, property_id, role)
       VALUES ($1, $2, $3, NULL, 'OWNER')`,
      [randomUUID(), data.organizationId, ownerId],
    );

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
    /*
     * Order matters: every foreign key in this schema is ON DELETE RESTRICT,
     * so a child left behind blocks its parent and ultimately the organization.
     *
     * The channel tables were missing until the channel admin screens existed,
     * and their absence was invisible because globalTeardown swallowed the
     * error — leaving a stranded organization in the database after every run.
     */
    for (const table of [
      'notifications',
      'outbox_events',
      'audit_logs',
      'channel_reservations',
      'sync_jobs',
      'channel_rate_plan_mappings',
      'channel_room_type_mappings',
      'channels',
      // Before reservations: a folio line references its booking with RESTRICT,
      // so an unpaid-attention table here strands the whole organization —
      // which is exactly how the channel tables were found missing.
      'folio_payments',
      'folio_charges',
      'reservations',
      'guests',
      'inventory_days',
      'physical_rooms',
      'rate_days',
      'rate_plans',
      'room_types',
      'memberships',
      'refresh_tokens',
      'password_reset_tokens',
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

export interface IsolatedRoomType {
  roomTypeId: string;
  ratePlanId: string;
  roomTypeName: string;
  dates: string[];
}

/**
 * A room type, rate plan and inventory that belong to ONE spec.
 *
 * The shared fixture room type is asserted on by the inventory and reservation
 * specs with absolute counts ("0/5"), and the suite runs serially. Any spec
 * that BOOKS has to bring its own rows, or it silently breaks whichever spec
 * happens to run after it — which is exactly what happened when the booking
 * spec was first added.
 */
export async function seedIsolatedRoomType(
  data: TestData,
  options: { code: string; name: string; dates: string[]; allotment?: number },
): Promise<IsolatedRoomType> {
  const pool = new Pool({ connectionString: connectionString(), max: 2 });
  const roomTypeId = randomUUID();
  const ratePlanId = randomUUID();

  try {
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name,
                               standard_occupancy, max_occupancy, max_adults, max_children, sort_order)
       VALUES ($1, $2, $3, $4, $5, 2, 4, 3, 2, 50)`,
      [roomTypeId, data.organizationId, data.propertyId, options.code, options.name],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name)
       VALUES ($1, $2, $3, $4, $5, 'Isolated Rate')`,
      [ratePlanId, data.organizationId, data.propertyId, roomTypeId, `${options.code}-BAR`],
    );

    for (const date of options.dates) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [data.organizationId, data.propertyId, roomTypeId, date, options.allotment ?? 5],
      );
      for (const occupancy of [1, 2, 3]) {
        await pool.query(
          `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date,
                                  occupancy, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 250000, 'THB')`,
          [data.organizationId, data.propertyId, ratePlanId, date, occupancy],
        );
      }
    }

    return { roomTypeId, ratePlanId, roomTypeName: options.name, dates: options.dates };
  } finally {
    await pool.end();
  }
}

/** Removes everything `seedIsolatedRoomType` created, bookings included. */
export async function removeIsolatedRoomType(room: IsolatedRoomType): Promise<void> {
  const pool = new Pool({ connectionString: connectionString(), max: 2 });
  try {
    // Folio lines first, then reservations: both reference their parent with
    // RESTRICT, so the order is the reverse of how they were created.
    for (const table of ['folio_payments', 'folio_charges']) {
      await pool.query(
        `DELETE FROM ${table} WHERE reservation_id IN (
           SELECT reservation_id FROM reservation_stays WHERE room_type_id = $1
         )`,
        [room.roomTypeId],
      );
    }
    await pool.query(
      `DELETE FROM reservations WHERE id IN (
         SELECT reservation_id FROM reservation_stays WHERE room_type_id = $1
       )`,
      [room.roomTypeId],
    );
    await pool.query('DELETE FROM inventory_days WHERE room_type_id = $1', [room.roomTypeId]);
    await pool.query('DELETE FROM rate_days WHERE rate_plan_id = $1', [room.ratePlanId]);
    await pool.query('DELETE FROM channel_rate_plan_mappings WHERE rate_plan_id = $1', [
      room.ratePlanId,
    ]);
    await pool.query('DELETE FROM channel_room_type_mappings WHERE room_type_id = $1', [
      room.roomTypeId,
    ]);
    await pool.query('DELETE FROM rate_plans WHERE id = $1', [room.ratePlanId]);
    await pool.query('DELETE FROM room_types WHERE id = $1', [room.roomTypeId]);
  } finally {
    await pool.end();
  }
}

/**
 * Plant a live password-reset token and hand back the raw value.
 *
 * The only place the raw token normally exists is the email, which is exactly
 * what makes the design safe — so a browser test cannot read one out of the
 * database and has to mint its own. Mirrors the API's token format: 32 random
 * bytes, base64url, stored as SHA-256.
 */
export async function seedResetToken(
  data: TestData,
  email: string,
  options: { expiresInMinutes?: number } = {},
): Promise<string> {
  const pool = new Pool({ connectionString: connectionString(), max: 2 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE organization_id = $1 AND lower(email) = lower($2)',
      [data.organizationId, email],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error(`No fixture user for ${email}`);

    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO password_reset_tokens
         (id, organization_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [
        randomUUID(),
        data.organizationId,
        userId,
        createHash('sha256').update(token).digest('hex'),
        options.expiresInMinutes ?? 30,
      ],
    );
    return token;
  } finally {
    await pool.end();
  }
}
