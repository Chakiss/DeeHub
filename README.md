# DeeHub Hotel

An AI-first hotel platform: reservations, inventory, rates and OTA
connectivity in one system.

Read [`CLAUDE.md`](CLAUDE.md) first — it is the engineering charter and the
single source of truth for how this project is built.

## Getting started

Requires Node 22+, pnpm 11+, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres, Redis, MinIO
pnpm db:migrate        # apply migrations
pnpm db:seed           # demo hotel, rates, a year of inventory, three users
pnpm test              # unit + integration tests
pnpm --filter @deehub/api dev
```

The API then serves:

| URL                                | Purpose                          |
| ---------------------------------- | -------------------------------- |
| http://localhost:3001/health       | Liveness                         |
| http://localhost:3001/health/ready | Readiness (checks Postgres)      |
| http://localhost:3001/api/v1/docs  | OpenAPI UI (non-production only) |

Local infrastructure uses **project-scoped ports** so it never collides with
a Postgres or Redis you already run: Postgres `15432`, Redis `16379`, MinIO
`19000` (console `19001`).

## Commands

| Command                                        | Does                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| `pnpm build` / `pnpm test` / `pnpm typecheck`  | Across all workspaces via Turborepo                    |
| `pnpm db:generate`                             | Generate a migration after changing the Drizzle schema |
| `pnpm db:migrate`                              | Apply pending migrations                               |
| `pnpm infra:up` / `infra:down` / `infra:reset` | Local Docker stack (`reset` wipes volumes)             |
| `pnpm format`                                  | Prettier                                               |

## Layout

```
apps/
  api/            NestJS — modular monolith, one module per bounded context
packages/
  shared/         Money, hotel-night dates, error taxonomy, event contracts
infrastructure/   docker-compose for local development
docs/             design documentation (see below)
```

## Documentation

| Document                                | Contents                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| [vision.md](docs/vision.md)             | Problem, customer, product, success metrics                 |
| [roadmap.md](docs/roadmap.md)           | Phases to the 90-day milestone and beyond                   |
| [domain-model.md](docs/domain-model.md) | Bounded contexts, aggregates, invariants, events            |
| [architecture.md](docs/architecture.md) | Modular monolith, layering, booking transaction, connectors |
| [database.md](docs/database.md)         | Schema, constraints, indexes, the queries that matter       |
| [api-spec.md](docs/api-spec.md)         | REST contract, error taxonomy, idempotency                  |
| [adr/](docs/adr/)                       | Architecture decision records                               |

## The one thing to know

Availability is a **count per room type per night** (ADR-0002), and
overbooking is prevented at two independent layers:

1. a `CHECK (booked >= 0 AND booked <= allotment)` constraint, which holds
   even if application code is wrong; and
2. a guarded `UPDATE ... WHERE booked + units <= allotment` whose affected
   row count must equal the number of nights, inside a transaction that locks
   rows in date order.

`apps/api/src/database/inventory-guard.integration.test.ts` proves both
against a real PostgreSQL, including concurrent bookings racing for the last
room. If you change anything in that path, those tests are the contract.
