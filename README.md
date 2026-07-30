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
pnpm --filter @deehub/api dev        # HTTP API      :3001
pnpm --filter @deehub/admin-web dev  # dashboard     :3000
pnpm --filter @deehub/api dev:worker # background worker
pnpm --filter @deehub/mock-ota dev   # stand-in OTA on :4001
pnpm db:seed-channel                 # connect the demo hotel to it
```

To watch a booking flow in from the channel, start the Mock OTA with
`MOCK_OTA_WEBHOOK_URL=http://127.0.0.1:3001/api/v1/webhooks/channels/<channelId>`
and simulate a guest booking:

```bash
curl -X POST http://127.0.0.1:4001/api/simulate/booking \
  -H 'x-api-key: mock-ota-dev-key' -H 'content-type: application/json' \
  -d '{"hotelCode":"DEEHUB-DEMO","roomId":"OTA-DLX",
       "arrival":"20261020","departure":"20261022","guestName":"Ploy"}'
```

The **worker** is a second entry point in the same package
(`apps/api/src/worker.ts`). It runs the outbox relay, debounced ARI pushes,
hold expiry every minute, and inventory reconciliation nightly at 03:00.

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
                  (main.ts = HTTP, worker.ts = background jobs)
  admin-web/      Next.js dashboard — inventory grid, reservations
  mock-ota/       Stand-in OTA: the harness every connector is certified against
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

## Dashboard notes

The dashboard is a **backend-for-frontend**: the browser never holds a DeeHub
token. `/api/session/login` proxies to the API and stores tokens in httpOnly
cookies on the dashboard's own origin; middleware refreshes them silently and
rotates the refresh token. There is no CORS, and an XSS bug in a component
cannot exfiltrate a session.

Two things to know before deploying it:

- `output: 'standalone'` does **not** include static assets. They must be
  copied to `.next/standalone/apps/admin-web/.next/static` — the Dockerfile does
  this. Without it the app serves HTML whose scripts and styles all 404, which
  looks like a blank page with no error anywhere.
- The API client in `src/lib/api.ts` is hand-written. architecture.md §8 calls
  for one generated from the OpenAPI document with a CI drift check; that is
  deferred until the endpoint surface settles.

## Deploying

Google Cloud, three Cloud Run services from two images. See
[deployment.md](docs/deployment.md) for the full runbook; the short version:

```bash
docker build -f apps/api/Dockerfile -t deehub-api .        # API + worker + migrations
docker build -f apps/admin-web/Dockerfile -t deehub-web .  # dashboard
```

`.github/workflows/deploy.yml` runs CI, pushes both images tagged by commit SHA,
executes migrations as a Cloud Run job, deploys, and smoke-tests
`/health/ready`. Infrastructure is Terraform in `infrastructure/terraform`.

Nothing here has been applied to GCP yet — the config validates and both images
have been built and run locally against a real database, but the first apply
should be treated as a first apply.

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
