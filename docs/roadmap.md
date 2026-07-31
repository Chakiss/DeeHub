# DeeHub Hotel — Product Roadmap

Dates are planning targets from 2026-07-29, not commitments. Each phase ends
with something running in production.

## Phase 0 — Foundation (Weeks 1–2)

Goal: a repo where every subsequent feature lands with CI, tests, and docs.

- Monorepo scaffold (pnpm workspaces + Turborepo): `apps/api` (NestJS),
  `apps/admin-web` (Next.js), `apps/worker` (BullMQ), `packages/shared`.
- Docker Compose local stack: Postgres, Redis, MinIO.
- CI on GitHub Actions: lint, typecheck, unit + integration tests, build.
- Core docs: architecture, domain model, database design (Tasks 3–5).
- Auth + tenancy skeleton: Organization, User, JWT + refresh, org-scoped
  request context, audit-log plumbing.

## Phase 1 — Reservation + Inventory Core (Weeks 3–8)

Goal: the source of truth, correct under concurrency.

- Properties, Room Types, Physical Rooms, Rate Plans CRUD.
- Inventory: allotment per room type per night; stop-sell, min-stay, CTA/CTD;
  atomic overbooking guard; nightly reconciliation job.
- Reservations: create/modify/cancel with state machine
  (pending → confirmed → checked-in → checked-out / cancelled / no-show),
  guest records, price snapshot at booking time.
- Domain events (reservation.created, inventory.changed, …) on BullMQ.
- Audit logging on every state change.

## Phase 2 — Sync Engine + Mock OTA + Dashboard (Weeks 9–13)

Goal: the 90-day milestone — production-ready core with connector framework.

- OTA Connector framework: uniform interface (push ARI, receive
  reservations), OTA mapping tables (room type ↔ channel room, rate plan ↔
  channel rate).
- Sync Engine: change detection → per-channel push queue with retry,
  backoff, dead-letter, and full sync/delta sync; conflict rule = never
  oversell.
- **Mock OTA**: a fake channel (own API + tiny UI) that receives ARI and
  sends reservations — proves the framework end to end and becomes the
  permanent integration-test harness.
- Admin Dashboard (Next.js): calendar grid for inventory/rates, reservation
  list + detail, manual reservation entry, audit log viewer.
- Production deploy on Cloud Run; Sentry; backups; 1–3 pilot properties.

**Milestone 1 exit criteria:** pilot hotels manage real inventory; Mock OTA
round-trips bookings; zero platform-caused overbookings; sync < 60 s.

**Status (2026-07-31). Phase 2 is complete and deployed.** The three items
that were outstanding are done: the infrastructure is applied (47 resources,
clean plan), the first organization exists, and the dashboard has its own
browser suite. Pushes to `main` build, verify and deploy on their own.

Since then the product has gone well past Phase 2 scope, and has taken most of
Phase 4 with it. Delivered:

- **Setup path**, end to end: room types, rate plans and nightly pricing
  through the UI — an empty property to a sellable one without SQL. Rates can
  now be cleared for a date range as well as set.
- **Front desk**: physical rooms, housekeeping status, Stay View, room
  assignment, check-in and check-out. Reservations can be taken at the desk
  (manual booking), an unstarted stay can have its dates, room type, rate plan
  or occupancy changed, and a stay already under way can be extended.
- **Guests**: profiles and stay history.
- **Reporting**: occupancy, ADR and RevPAR.
- **Channels**: created, credentialed, mapped and activated from the
  dashboard rather than by hand-written SQL.
- **Operations**: Thai UI, the audit trail readable in the dashboard,
  alerting and error reporting, operator-driven password reset, team
  administration with a one-time credential, and a password change that
  revokes every other session.

**What a pilot property still cannot do**, in the order it will hurt:

1. **Recover a forgotten password without help.** An operator can reset one
   for a colleague, so nobody is locked out permanently, but self-service
   `forgot-password` / `reset-password` are still specified and not built.
2. **Sell through an OTA.** The connector framework and Mock OTA work end to
   end and a channel can now be configured from the dashboard, but no real
   channel is connected, `test-connection` and forced sync are not built, and
   pushing anything at all requires `enable_channel_sync`, which adds Redis
   and an always-on worker (roughly $80/month on top of the current ~$22).
3. **Be told anything.** No notifications: no booking confirmation to the
   guest, no alert to staff. Everything is pull-only, in the dashboard.

## Phase 3 — First Real OTA + Booking Engine (Months 4–6)

- First real connector (**Agoda** first — Thailand priority; then
  Booking.com), certification process.
- Reservation delivery inbox: channel bookings auto-ingested, deduplicated,
  and mapped.
- Direct Booking Engine v1: availability search, book, basic payment
  (deposit via Omise/Stripe — payments enter the roadmap here).
- Rate Plans v2: derived rates (percentage/amount off parent), promotions.
- ~~Thai UI translation.~~ **Done** — pulled forward, the whole dashboard is
  bilingual.

## Phase 4 — PMS Operations + CRM (Months 6–9)

Mostly delivered early; what is left is listed as **remaining**.

- Front desk: ~~room assignment, check-in/out, housekeeping status board~~
  **done**. Folio basics **remaining** — there is a price snapshot per
  booking, but no per-stay account of charges, payments and balance.
- Guests → CRM: ~~profiles, stay history~~ **done**. Dedupe/merge
  **remaining** — a returning guest booked under a different spelling is two
  records today.
- Notifications: email/LINE confirmations to guests, alerts to staff —
  **remaining**, none of it built.
- Reporting v1: ~~occupancy, ADR, RevPAR~~ **done**. Pickup **remaining** —
  it needs booking-date history, not just stay dates.

## Phase 5 — Revenue + AI Assistant (Months 9–12+)

- More connectors: Expedia, Trip.com, Airbnb.
- Revenue management: demand-based rate suggestions, competitor awareness.
- Analytics dashboards.
- AI Assistant v1: natural-language queries over the platform ("occupancy
  next weekend?"), drafted actions (rate changes) with human approval.

## Standing rules

- Modular monolith until scale forces otherwise.
- Every feature meets the Definition of Done in `CLAUDE.md`.
- Anything that slips, slips to the _next_ phase — Milestone 1 scope is fixed.
