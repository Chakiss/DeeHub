/**
 * Migration runner.
 *
 * Forward-only, versioned, reviewed (docs/database.md §12). Drizzle records
 * applied migrations in `drizzle.__drizzle_migrations`, so this is safe to run
 * repeatedly and safe to run on boot in a deploy step.
 */
import '../config/load-dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  // A dedicated single-connection pool: migrations take DDL locks and must not
  // compete with application traffic.
  const pool = new Pool({ connectionString, max: 1 });

  try {
    const db = drizzle(pool);
    const migrationsFolder = join(__dirname, 'migrations');
    process.stdout.write(`Applying migrations from ${migrationsFolder}\n`);
    await migrate(db, { migrationsFolder });
    process.stdout.write('Migrations applied successfully\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});
