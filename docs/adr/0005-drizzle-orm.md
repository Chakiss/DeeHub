# ADR-0005: Drizzle ORM for the data layer

- **Status:** Accepted
- **Date:** 2026-07-29
- **Decider:** AI (CTO role), pending founder objection

## Context

[database.md](../database.md) commits to composite primary keys, partial
unique indexes, `CHECK` constraints, `SELECT ... FOR UPDATE ORDER BY`,
`FOR UPDATE SKIP LOCKED`, and a guarded `UPDATE` whose row count is the
overbooking guarantee. The critical path of this product is hand-written SQL.

Candidates: TypeORM (the NestJS default), Prisma, Drizzle.

## Decision

Use **Drizzle ORM** with `drizzle-kit` for migrations and `pg` as the driver.

Reasons, in order of weight:

1. **Raw SQL is a first-class citizen.** The booking guard and the outbox
   relay are written as SQL and stay readable. TypeORM's query builder fights
   row-level locking with composite keys; Prisma pushes such queries into
   `$queryRaw`, losing type safety exactly where correctness matters most.
2. **Schema features we actually use.** Composite PKs, partial indexes and
   CHECK constraints are expressible in the schema DSL, so the constraints
   that enforce our invariants live in version-controlled TypeScript rather
   than hand-patched migrations.
3. **Migrations are plain SQL files**, generated from the schema and then
   reviewed — exactly the "versioned, forward-only, reviewed" policy
   database.md already commits to.
4. **Type inference without decorators or codegen daemons**, which suits
   Clean Architecture: Drizzle tables are infrastructure-layer values, not
   decorated domain classes, so the domain layer stays free of ORM types.
5. Actively maintained; TypeORM has been in low-maintenance mode for years.

## Consequences

- Less NestJS-idiomatic than TypeORM: no `@InjectRepository`. We provide a
  `DATABASE` token via a `DatabaseModule` and inject the typed client. Our
  repositories are hand-written anyway (Repository Pattern per the master
  prompt), so this costs nothing.
- No lazy relations or entity change tracking. We do not want either — the
  domain layer owns identity and lifecycle.
- Drizzle cannot express every cross-row rule (e.g. "a derived rate plan's
  parent must not itself be derived"); those stay in domain services and
  triggers, as database.md already specifies.
- Team knowledge: Drizzle's SQL-first model is easier to reason about for an
  AI-primary codebase, since generated code is close to the SQL it runs.
