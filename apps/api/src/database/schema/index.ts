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
export * from './booking-source';
export * from './reservation';
export * from './platform';
export * from './notification';
export * from './reporting';
export * from './folio';
export * from './payment';
export * from './sync';
export * from './accounting';
export * from './rate-view';
