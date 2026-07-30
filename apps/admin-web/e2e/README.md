# Dashboard end-to-end tests

Playwright, against a real browser, a real API and a real database — the same
contract as the backend integration suites.

```bash
pnpm infra:up                      # Postgres + Redis
pnpm db:migrate
pnpm --filter @deehub/api start    # API on :3001
pnpm --filter @deehub/admin-web test:e2e
```

Playwright builds and starts the dashboard itself on port 3100. It uses the
**production build**, not `next dev`: the dev server has different hydration and
caching behaviour, so testing it would test something we never ship.

Each run seeds its own organization and deletes it afterwards, so the suite is
safe against a shared development database and a failure leaves evidence only
in its own rows.

The specs run serially and share one seeded property — several of them mutate
its inventory, so parallel workers would race on the same rows.
