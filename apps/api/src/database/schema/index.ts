/**
 * Drizzle schema — the physical model described in docs/database.md.
 *
 * These tables are INFRASTRUCTURE. Domain entities are plain TypeScript and
 * must not import from here (architecture.md §2); repositories map between
 * the two.
 */
export * from './identity';
export * from './property';
export * from './access';
export * from './inventory';
export * from './guest';
export * from './channel';
export * from './reservation';
export * from './platform';
export * from './notification';
