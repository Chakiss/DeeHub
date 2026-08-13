/**
 * Fills an empty property in: room types, rate plans, physical rooms, nightly
 * allotment and nightly prices.
 *
 * `db:create-org` makes an organization, a property and an owner. That property
 * can be logged into and cannot sell anything — it has no room types, so no
 * inventory and no rates. This is the second half, and it is the difference
 * between an account and a hotel that can take a booking.
 *
 * Everything it writes could be typed into the dashboard instead. A script
 * exists because the first thing a new property does is a hundred near-
 * identical rows across a year of dates, and because onboarding the second
 * hotel should not be a fresh hour of clicking.
 *
 * **Idempotent.** Room types, rate plans and rooms are matched by code and
 * skipped if present; allotment and rates are upserted per date. Re-running
 * after a partial failure, or to extend the horizon, is the expected way to use
 * it — not a risk to be careful about.
 *
 *   DEEHUB_SETUP_JSON="$(cat infrastructure/onboarding/lets-chill.json)" \
 *     pnpm --filter @deehub/api db:setup-property
 *
 * Against production the database is only reachable from inside the VPC, so
 * this runs as a Cloud Run job execution — the same route `create-organization`
 * takes, and the reason the input is one environment variable rather than a
 * list of flags.
 */
import '../config/load-dotenv';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import * as schema from './schema';

interface RoomTypeSetup {
  /** Short code the hotel recognises; also the idempotency key. */
  readonly code: string;
  readonly name: string;
  readonly rooms: number;
  readonly maxAdults: number;
  readonly maxChildren?: number;
  /** Baht per night, as a whole number. Stored in satang. */
  readonly rate: number;
  /** Room numbers as the hotel says them. Defaults to CODE-1, CODE-2, … */
  readonly roomNumbers?: readonly string[];
  /** What the channel calls this room type, if it is already on one. */
  readonly externalIds?: Readonly<Record<string, string>>;
}

interface PropertySetup {
  readonly organizationSlug: string;
  readonly propertyCode: string;
  /** How many nights forward to open for sale. A year unless told otherwise. */
  readonly horizonDays?: number;
  /**
   * VAT and service charge, as percentages, and whether the rates below already
   * contain them.
   *
   * Required, with no default, because the default is the thing that goes
   * wrong. A new property is created at 7% VAT and 10% service on top of the
   * rate, so a ฿1,300 room quotes ฿1,530 — and if ฿1,300 is what the hotel
   * advertises on an OTA, every price in the system is now 17.7% adrift from
   * the price a guest was shown. Making this explicit costs one line of config
   * and one conversation; getting it wrong costs an argument at the desk.
   */
  readonly tax: {
    readonly vatPercent: number;
    readonly serviceChargePercent: number;
    /** True when the rates below are what the guest pays, all in. */
    readonly ratesIncludeTax: boolean;
  };
  readonly roomTypes: readonly RoomTypeSetup[];
}

function loadSetup(): PropertySetup {
  const inline = process.env['DEEHUB_SETUP_JSON'];
  const path = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const raw = inline ?? (path ? readFileSync(path, 'utf8') : undefined);
  if (!raw) {
    throw new Error(
      'Nothing to do. Pass a config file path, or set DEEHUB_SETUP_JSON to its contents.',
    );
  }

  const setup = JSON.parse(raw) as PropertySetup;
  if (!setup.organizationSlug || !setup.propertyCode) {
    throw new Error('organizationSlug and propertyCode are required');
  }
  if (!Array.isArray(setup.roomTypes) || setup.roomTypes.length === 0) {
    throw new Error('At least one room type is required — a property with none cannot sell');
  }
  if (
    !setup.tax ||
    typeof setup.tax.vatPercent !== 'number' ||
    typeof setup.tax.serviceChargePercent !== 'number' ||
    typeof setup.tax.ratesIncludeTax !== 'boolean'
  ) {
    throw new Error(
      'tax is required: { vatPercent, serviceChargePercent, ratesIncludeTax }. ' +
        'Ask the hotel whether the rate they quote is what the guest pays.',
    );
  }
  for (const roomType of setup.roomTypes) {
    if (!roomType.code || !roomType.name) throw new Error('Every room type needs a code and name');
    if (!Number.isInteger(roomType.rooms) || roomType.rooms < 1) {
      throw new Error(`${roomType.code}: rooms must be a positive whole number`);
    }
    if (!Number.isInteger(roomType.rate) || roomType.rate < 1) {
      throw new Error(`${roomType.code}: rate must be a positive whole number of baht`);
    }
    if (roomType.roomNumbers && roomType.roomNumbers.length !== roomType.rooms) {
      throw new Error(
        `${roomType.code}: ${roomType.roomNumbers.length} room numbers for ${roomType.rooms} rooms`,
      );
    }
  }
  return setup;
}

/** Business dates from today forward, in the property's own timezone (ADR-0003). */
function horizon(timezone: string, days: number): string[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const start = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

async function main(): Promise<void> {
  const setup = loadSetup();
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });

  try {
    const [organization] = await db
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, setup.organizationSlug))
      .limit(1);
    if (!organization) {
      throw new Error(
        `No organization with slug "${setup.organizationSlug}". Run db:create-org first.`,
      );
    }

    const [property] = await db
      .select({
        id: schema.properties.id,
        name: schema.properties.name,
        timezone: schema.properties.timezone,
        currency: schema.properties.currency,
      })
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.organizationId, organization.id),
          eq(schema.properties.code, setup.propertyCode),
        ),
      )
      .limit(1);
    if (!property) {
      throw new Error(
        `No property with code "${setup.propertyCode}" in ${setup.organizationSlug}.`,
      );
    }

    // Set before anything is priced, so every rate written below is stored
    // against the tax treatment the hotel actually uses.
    await db
      .update(schema.properties)
      .set({
        taxRateBp: Math.round(setup.tax.vatPercent * 100),
        serviceChargeRateBp: Math.round(setup.tax.serviceChargePercent * 100),
        pricesIncludeTax: setup.tax.ratesIncludeTax,
      })
      .where(eq(schema.properties.id, property.id));

    const dates = horizon(property.timezone, setup.horizonDays ?? 365);
    console.log(
      `${organization.name} → ${property.name} (${property.timezone}, ${property.currency})`,
    );
    console.log(
      `VAT ${setup.tax.vatPercent}%, service ${setup.tax.serviceChargePercent}%, rates ` +
        `${setup.tax.ratesIncludeTax ? 'INCLUDE' : 'exclude'} them`,
    );
    console.log(`Opening ${dates.length} nights, ${dates[0]} to ${dates[dates.length - 1]}\n`);

    for (const roomType of setup.roomTypes) {
      const existing = await db
        .select({ id: schema.roomTypes.id })
        .from(schema.roomTypes)
        .where(
          and(
            eq(schema.roomTypes.organizationId, organization.id),
            eq(schema.roomTypes.propertyId, property.id),
            eq(schema.roomTypes.code, roomType.code),
          ),
        )
        .limit(1);

      let roomTypeId = existing[0]?.id;
      if (roomTypeId) {
        console.log(`  ${roomType.code}  room type exists, leaving it alone`);
      } else {
        roomTypeId = uuidv7();
        await db.insert(schema.roomTypes).values({
          id: roomTypeId,
          organizationId: organization.id,
          propertyId: property.id,
          code: roomType.code,
          name: roomType.name,
          // Standard occupancy is what the rate is quoted for. Two, unless the
          // room cannot hold two.
          standardOccupancy: Math.min(2, roomType.maxAdults),
          maxOccupancy: roomType.maxAdults + (roomType.maxChildren ?? 0),
          maxAdults: roomType.maxAdults,
          maxChildren: roomType.maxChildren ?? 0,
        });
        console.log(`  ${roomType.code}  created "${roomType.name}"`);
      }

      const planCode = `${roomType.code}-BAR`;
      const existingPlan = await db
        .select({ id: schema.ratePlans.id })
        .from(schema.ratePlans)
        .where(
          and(
            eq(schema.ratePlans.organizationId, organization.id),
            eq(schema.ratePlans.propertyId, property.id),
            eq(schema.ratePlans.code, planCode),
          ),
        )
        .limit(1);

      let ratePlanId = existingPlan[0]?.id;
      if (!ratePlanId) {
        ratePlanId = uuidv7();
        await db.insert(schema.ratePlans).values({
          id: ratePlanId,
          organizationId: organization.id,
          propertyId: property.id,
          roomTypeId,
          code: planCode,
          name: 'ราคาปกติ',
        });
        console.log(`  ${roomType.code}  rate plan ${planCode}`);
      }

      // Physical rooms exist for assignment and housekeeping only; they never
      // decide what is sellable (ADR-0002). The COUNT of them is the hotel's
      // reality, so the allotment below is taken from it.
      const numbers =
        roomType.roomNumbers ??
        Array.from({ length: roomType.rooms }, (_, index) => `${roomType.code}-${index + 1}`);
      let created = 0;
      for (const roomNumber of numbers) {
        const already = await db
          .select({ id: schema.physicalRooms.id })
          .from(schema.physicalRooms)
          .where(
            and(
              eq(schema.physicalRooms.organizationId, organization.id),
              eq(schema.physicalRooms.propertyId, property.id),
              eq(schema.physicalRooms.roomNumber, roomNumber),
            ),
          )
          .limit(1);
        if (already.length > 0) continue;
        await db.insert(schema.physicalRooms).values({
          id: uuidv7(),
          organizationId: organization.id,
          propertyId: property.id,
          roomTypeId,
          roomNumber,
        });
        created += 1;
      }
      console.log(`  ${roomType.code}  ${created} of ${numbers.length} rooms created`);

      /*
       * Allotment and price, one row per night.
       *
       * Upserted rather than inserted, so re-running to extend the horizon or
       * fix a price does not fail on the nights that already exist — and, more
       * importantly, does not touch `booked`. Overwriting that would forget
       * every reservation the property has taken.
       */
      const amountMinor = roomType.rate * 100;
      for (const date of dates) {
        await db
          .insert(schema.inventoryDays)
          .values({
            organizationId: organization.id,
            propertyId: property.id,
            roomTypeId,
            date,
            allotment: roomType.rooms,
          })
          .onConflictDoUpdate({
            target: [schema.inventoryDays.roomTypeId, schema.inventoryDays.date],
            set: { allotment: roomType.rooms },
          });

        // Every occupancy the room admits, at one price. A hotel that charges
        // per head changes these in the grid; most Thai properties do not.
        for (let occupancy = 1; occupancy <= roomType.maxAdults; occupancy += 1) {
          await db
            .insert(schema.rateDays)
            .values({
              organizationId: organization.id,
              propertyId: property.id,
              ratePlanId,
              date,
              occupancy,
              amountMinor,
              currency: property.currency,
            })
            .onConflictDoUpdate({
              target: [schema.rateDays.ratePlanId, schema.rateDays.date, schema.rateDays.occupancy],
              set: { amountMinor, currency: property.currency },
            });
        }
      }
      console.log(
        `  ${roomType.code}  ${roomType.rooms}/night at ${roomType.rate} ${property.currency} ` +
          `for ${dates.length} nights\n`,
      );
    }

    const counted = await db
      .select({ sellable: sql<number>`count(*)::int` })
      .from(schema.inventoryDays)
      .where(eq(schema.inventoryDays.propertyId, property.id));
    console.log(`Done. ${counted[0]?.sellable ?? 0} room-type nights are now on sale.`);
    console.log('Check the inventory grid before pointing a channel at it.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
