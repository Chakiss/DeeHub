import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ENV, type Env } from '../config/env';
import * as schema from './schema';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Postgres access (ADR-0005).
 *
 * Drizzle tables are infrastructure. Domain code must not import them;
 * repositories map between rows and domain entities (architecture.md §2).
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ENV],
      useFactory: (env: Env): Pool =>
        new Pool({
          connectionString: env.DATABASE_URL,
          // Cloud Run scales horizontally, so each instance keeps a small pool;
          // a large pool per instance would exhaust Cloud SQL connections long
          // before it improved throughput.
          max: 10,
          idleTimeoutMillis: 30_000,
          /*
           * 15s, not 5s. A shared-core Cloud SQL instance (db-f1-micro, no SLA)
           * takes longer than five seconds to hand out a connection often
           * enough to matter: roughly one maintenance run in three died on
           * "Connection terminated due to connection timeout" through August
           * 2026, which is what led to the job being paused and guest email
           * stopping with it.
           *
           * The cost of waiting longer is bounded — a request that would have
           * failed now takes up to ten seconds more to fail. The cost of the
           * short timeout was a housekeeping job that looked broken while the
           * database was merely slow.
           */
          connectionTimeoutMillis: 15_000,
        }),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
  ],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /** Drain connections on shutdown so Cloud Run instances exit cleanly. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
