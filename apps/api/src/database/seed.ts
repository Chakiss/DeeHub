/**
 * Development seed: one organization, one property, four room types, physical
 * rooms, a BAR rate plan, a year of inventory and rates, and three users.
 *
 * Idempotent — safe to re-run. Never run against production: it creates known
 * credentials on purpose, and refuses to start if NODE_ENV says production.
 */
import '../config/load-dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { addDays, businessDate, toIsoDate } from '@deehub/shared';
import { v7 as uuidv7 } from 'uuid';
import { ScryptPasswordHasher } from '../modules/auth/domain/password-hasher';
import * as schema from './schema';

const DEMO_SLUG = 'deehub-demo';
const DEMO_PASSWORD = 'deehub-dev-password';
const HORIZON_DAYS = 365;

const ROOM_TYPES = [
  { code: 'STD', name: 'Standard Twin', rooms: 8, occupancy: 2, max: 2, rate: 120000 },
  { code: 'DLX', name: 'Deluxe Double', rooms: 6, occupancy: 2, max: 3, rate: 180000 },
  { code: 'SUI', name: 'Pool Suite', rooms: 3, occupancy: 2, max: 4, rate: 350000 },
  { code: 'FAM', name: 'Family Room', rooms: 3, occupancy: 4, max: 5, rate: 260000 },
] as const;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database: it creates known credentials.');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  const hasher = new ScryptPasswordHasher();

  try {
    const existing = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations WHERE slug = ${DEMO_SLUG} LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      process.stdout.write(`Demo organization "${DEMO_SLUG}" already exists — nothing to do.\n`);
      return;
    }

    const organizationId = uuidv7();
    const propertyId = uuidv7();
    const passwordHash = await hasher.hash(DEMO_PASSWORD);

    await db.transaction(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: organizationId,
        name: 'DeeHub Demo Hotels',
        slug: DEMO_SLUG,
        plan: 'TRIAL',
      });

      await tx.insert(schema.properties).values({
        id: propertyId,
        organizationId,
        code: 'DEMO1',
        name: 'DeeHub Demo Resort Phuket',
        timezone: 'Asia/Bangkok',
        currency: 'THB',
        country: 'TH',
        city: 'Phuket',
        taxRateBp: 700,
        serviceChargeRateBp: 1000,
      });

      // Three users covering the interesting permission boundaries.
      const users = [
        { email: 'owner@deehub.test', name: 'Somchai (Owner)', role: 'OWNER', scoped: false },
        { email: 'manager@deehub.test', name: 'Pim (Manager)', role: 'MANAGER', scoped: true },
        {
          email: 'frontdesk@deehub.test',
          name: 'Nok (Front Desk)',
          role: 'FRONT_DESK',
          scoped: true,
        },
      ] as const;

      for (const user of users) {
        const userId = uuidv7();
        await tx.insert(schema.users).values({
          id: userId,
          organizationId,
          email: user.email,
          passwordHash,
          fullName: user.name,
        });
        await tx.insert(schema.memberships).values({
          id: uuidv7(),
          organizationId,
          userId,
          propertyId: user.scoped ? propertyId : null,
          role: user.role,
        });
      }

      const today = businessDate('Asia/Bangkok');

      for (const [index, roomType] of ROOM_TYPES.entries()) {
        const roomTypeId = uuidv7();
        await tx.insert(schema.roomTypes).values({
          id: roomTypeId,
          organizationId,
          propertyId,
          code: roomType.code,
          name: roomType.name,
          standardOccupancy: roomType.occupancy,
          maxOccupancy: roomType.max,
          maxAdults: roomType.max,
          maxChildren: Math.max(0, roomType.max - roomType.occupancy),
          sortOrder: index,
        });

        // Physical rooms: 101.., 201.. by floor. Their count does NOT constrain
        // allotment (ADR-0002) — it just happens to match here.
        for (let n = 1; n <= roomType.rooms; n += 1) {
          await tx.insert(schema.physicalRooms).values({
            id: uuidv7(),
            organizationId,
            propertyId,
            roomTypeId,
            roomNumber: `${String(index + 1)}${String(n).padStart(2, '0')}`,
            floor: String(index + 1),
          });
        }

        const ratePlanId = uuidv7();
        await tx.insert(schema.ratePlans).values({
          id: ratePlanId,
          organizationId,
          propertyId,
          roomTypeId,
          code: `BAR-${roomType.code}`,
          name: `Best Available Rate — ${roomType.name}`,
          mealPlan: 'BREAKFAST',
          isRefundable: true,
        });

        const inventoryRows = [];
        const rateRows = [];
        for (let offset = 0; offset < HORIZON_DAYS; offset += 1) {
          const date = addDays(toIsoDate(today), offset);
          inventoryRows.push({
            organizationId,
            propertyId,
            roomTypeId,
            date,
            allotment: roomType.rooms,
            booked: 0,
          });

          // Weekend uplift, so the demo calendar is not flat.
          const dayIndex = new Date(`${date}T00:00:00Z`).getUTCDay();
          const isWeekend = dayIndex === 5 || dayIndex === 6;
          const amount = isWeekend ? Math.round(roomType.rate * 1.25) : roomType.rate;

          for (const occupancy of [1, 2, 3, 4, 5].slice(0, roomType.max)) {
            rateRows.push({
              organizationId,
              propertyId,
              ratePlanId,
              date,
              occupancy,
              // Extra guests pay a supplement above standard occupancy.
              amountMinor:
                occupancy <= roomType.occupancy
                  ? amount
                  : amount + (occupancy - roomType.occupancy) * 50000,
              currency: 'THB',
            });
          }
        }

        // Chunked: a single 1,800-row insert exceeds Postgres' parameter limit.
        for (let i = 0; i < inventoryRows.length; i += 500) {
          await tx.insert(schema.inventoryDays).values(inventoryRows.slice(i, i + 500));
        }
        for (let i = 0; i < rateRows.length; i += 500) {
          await tx.insert(schema.rateDays).values(rateRows.slice(i, i + 500));
        }
      }

      await tx.insert(schema.channels).values({
        id: uuidv7(),
        organizationId,
        propertyId,
        type: 'MOCK_OTA',
        name: 'Mock OTA (development)',
        status: 'INACTIVE',
      });
    });

    process.stdout.write(
      [
        'Seeded successfully.',
        '',
        `  Organization slug: ${DEMO_SLUG}`,
        `  Property:          DeeHub Demo Resort Phuket (${propertyId})`,
        `  Room types:        ${ROOM_TYPES.map((r) => r.code).join(', ')}`,
        `  Inventory:         ${String(HORIZON_DAYS)} days from today`,
        '',
        '  Logins (all with the same password):',
        '    owner@deehub.test      OWNER',
        '    manager@deehub.test    MANAGER (this property)',
        '    frontdesk@deehub.test  FRONT_DESK (this property)',
        `    password: ${DEMO_PASSWORD}`,
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${String(error)}\n`);
  process.exitCode = 1;
});
