import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Database } from './database.module';
import type * as schema from './schema';

export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Anything that can run a query: the pool-backed client or an open
 * transaction.
 *
 * Repository methods take an `Executor` rather than capturing the database,
 * which is what lets a use case compose several repositories inside ONE
 * transaction. The booking path depends on this: holding inventory, writing
 * the reservation, the audit entry and the outbox event must commit or fail
 * together (architecture.md §4).
 */
export type Executor = Database | Transaction;
