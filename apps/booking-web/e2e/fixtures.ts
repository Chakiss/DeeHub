import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * One organization per run, with a property a stranger can book: two room
 * types, one online plan and one desk-only plan, and thirty priced, open
 * nights from tomorrow. Seeded straight into Postgres, as the dashboard's
 * suite does, so the site under test is the only thing between the browser
 * and the API.
 */
export interface TestData {
  organizationId: string;
  organizationSlug: string;
  propertyId: string;
  propertyCode: string;
  roomTypeId: string;
  ratePlanId: string;
  deskPlanId: string;
  dates: string[];
}

function connectionString(): string {
  return process.env.DATABASE_URL ?? 'postgresql://deehub:deehub@localhost:15432/deehub';
}

export function testDataPath(): string {
  return resolve(process.cwd(), 'e2e/.test-data.json');
}

function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export async function seed(): Promise<TestData> {
  const pool = new Pool({ connectionString: connectionString(), max: 2 });
  const organizationId = randomUUID();
  const short = organizationId.slice(0, 8);
  const today = bangkokToday();
  const data: TestData = {
    organizationId,
    organizationSlug: `guest-${short}`,
    propertyId: randomUUID(),
    propertyCode: 'MAIN',
    roomTypeId: randomUUID(),
    ratePlanId: randomUUID(),
    deskPlanId: randomUUID(),
    dates: Array.from({ length: 30 }, (_, index) => addDays(today, index + 1)),
  };

  try {
    await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
      organizationId,
      'E2E Guest Org',
      data.organizationSlug,
    ]);
    await pool.query(
      `INSERT INTO properties (id, organization_id, code, name, timezone, currency, country,
                               tax_rate_bp, service_charge_rate_bp, prices_include_tax,
                               address_line1, city, latitude, longitude, description_en, description_th, amenities, phone)
       VALUES ($1, $2, $3, 'Sea Breeze Resort', 'Asia/Bangkok', 'THB', 'TH', 0, 0, true,
               '60/11 Huai Yai', 'Bang Lamung', 12.9236, 100.8825,
               'A quiet resort near Huai Yai.', 'รีสอร์ตเงียบสงบใกล้ห้วยใหญ่', '["Free Wi-Fi","Parking"]', '063 548 5456')`,
      [data.propertyId, organizationId, data.propertyCode],
    );
    await pool.query(
      `INSERT INTO room_types (id, organization_id, property_id, code, name, description, description_th,
                               bed_config, size_sqm, standard_occupancy, max_occupancy, max_adults, max_children)
       VALUES ($1, $2, $3, 'BUN', 'Standard Bungalow', 'A bungalow in the garden.', 'บังกะโลในสวน',
               '1 king bed', 28, 2, 2, 2, 0)`,
      [data.roomTypeId, organizationId, data.propertyId],
    );
    await pool.query(
      `INSERT INTO rate_plans (id, organization_id, property_id, room_type_id, code, name, sell_online, is_refundable)
       VALUES ($1, $2, $3, $4, 'BAR', 'Best Available Rate', true, true),
              ($5, $2, $3, $4, 'DESK', 'Walk-in special', false, false)`,
      [data.ratePlanId, organizationId, data.propertyId, data.roomTypeId, data.deskPlanId],
    );
    for (const date of data.dates) {
      await pool.query(
        `INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, allotment, booked)
         VALUES ($1, $2, $3, $4, 5, 0)`,
        [organizationId, data.propertyId, data.roomTypeId, date],
      );
      for (const [plan, amount] of [
        [data.ratePlanId, 45000],
        [data.deskPlanId, 30000],
      ] as const) {
        for (const occupancy of [1, 2]) {
          await pool.query(
            `INSERT INTO rate_days (organization_id, property_id, rate_plan_id, date, occupancy, amount_minor, currency)
             VALUES ($1, $2, $3, $4, $5, $6, 'THB')`,
            [organizationId, data.propertyId, plan, date, occupancy, amount],
          );
        }
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
      'notifications',
      'outbox_events',
      'audit_logs',
      'payment_intents',
      'folio_payments',
      'folio_charges',
      'reservations',
      'guests',
      'media',
      'inventory_days',
      'rate_days',
      'rate_plans',
      'room_types',
      'properties',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [data.organizationId]);
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [data.organizationId]);
  } finally {
    await pool.end();
  }
}
