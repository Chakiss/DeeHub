/**
 * Connects the seeded demo property to a locally running Mock OTA.
 *
 * Separate from `db:seed` because it needs the Mock OTA to be running:
 *
 *   pnpm --filter @deehub/mock-ota start
 *   pnpm db:seed-channel
 *
 * Idempotent, and refuses to run against production for the same reason the
 * main seed does — it writes known credentials.
 */
import '../config/load-dotenv';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { AesCredentialCipher } from '../common/crypto/credential-cipher';
import { loadEnv } from '../config/env';

const MOCK_OTA_URL = process.env.MOCK_OTA_URL ?? 'http://127.0.0.1:4001';
const HOTEL_CODE = 'DEEHUB-DEMO';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to wire a mock channel in production.');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const cipher = new AesCredentialCipher(loadEnv());

  try {
    const channels = await pool.query<{
      id: string;
      organization_id: string;
      property_id: string;
    }>(`SELECT id, organization_id, property_id FROM channels WHERE type = 'MOCK_OTA' LIMIT 1`);

    const channel = channels.rows[0];
    if (!channel) {
      throw new Error('No MOCK_OTA channel found. Run `pnpm db:seed` first.');
    }

    await pool.query(
      `UPDATE channels SET status = 'ACTIVE', credentials_encrypted = $1, updated_at = now()
        WHERE id = $2`,
      [
        cipher.encrypt({
          baseUrl: MOCK_OTA_URL,
          apiKey: process.env.MOCK_OTA_API_KEY ?? 'mock-ota-dev-key',
          hotelCode: HOTEL_CODE,
          webhookSecret: process.env.MOCK_OTA_WEBHOOK_SECRET ?? 'mock-ota-webhook-secret',
        }),
        channel.id,
      ],
    );

    const roomTypes = await pool.query<{ id: string; code: string }>(
      'SELECT id, code FROM room_types WHERE property_id = $1 ORDER BY sort_order',
      [channel.property_id],
    );
    for (const roomType of roomTypes.rows) {
      await pool.query(
        `INSERT INTO channel_room_type_mappings
           (id, organization_id, channel_id, room_type_id, external_room_id, external_room_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel_id, room_type_id) DO NOTHING`,
        [
          uuidv7(),
          channel.organization_id,
          channel.id,
          roomType.id,
          `OTA-${roomType.code}`,
          `Mock OTA ${roomType.code}`,
        ],
      );
    }

    const ratePlans = await pool.query<{ id: string; code: string }>(
      'SELECT id, code FROM rate_plans WHERE property_id = $1',
      [channel.property_id],
    );
    for (const ratePlan of ratePlans.rows) {
      await pool.query(
        `INSERT INTO channel_rate_plan_mappings
           (id, organization_id, channel_id, rate_plan_id, external_rate_id, external_rate_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel_id, rate_plan_id) DO NOTHING`,
        [
          uuidv7(),
          channel.organization_id,
          channel.id,
          ratePlan.id,
          `OTA-${ratePlan.code}`,
          `Mock OTA ${ratePlan.code}`,
        ],
      );
    }

    process.stdout.write(
      [
        `Mock OTA channel wired to ${MOCK_OTA_URL}`,
        `  hotel code:  ${HOTEL_CODE}`,
        `  room types:  ${roomTypes.rows.map((r) => `OTA-${r.code}`).join(', ')}`,
        `  rate plans:  ${String(ratePlans.rows.length)} mapped`,
        '',
        '  Inspect what the OTA holds:',
        `    curl -H 'x-api-key: mock-ota-dev-key' \\`,
        `      '${MOCK_OTA_URL}/api/ari?hotel_code=${HOTEL_CODE}&room_id=OTA-DLX'`,
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Channel seeding failed: ${String(error)}\n`);
  process.exitCode = 1;
});
