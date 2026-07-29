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

## Phase 3 — First Real OTA + Booking Engine (Months 4–6)

- First real connector (**Agoda** first — Thailand priority; then
  Booking.com), certification process.
- Reservation delivery inbox: channel bookings auto-ingested, deduplicated,
  and mapped.
- Direct Booking Engine v1: availability search, book, basic payment
  (deposit via Omise/Stripe — payments enter the roadmap here).
- Rate Plans v2: derived rates (percentage/amount off parent), promotions.
- Thai UI translation.

## Phase 4 — PMS Operations + CRM (Months 6–9)

- Front desk: room assignment, check-in/out, folio basics, housekeeping
  status board.
- Guests → CRM: profiles, stay history, dedupe/merge.
- Notifications: email/LINE confirmations to guests, alerts to staff.
- Reporting v1: occupancy, ADR, RevPAR, pickup.

## Phase 5 — Revenue + AI Assistant (Months 9–12+)

- More connectors: Expedia, Trip.com, Airbnb.
- Revenue management: demand-based rate suggestions, competitor awareness.
- Analytics dashboards.
- AI Assistant v1: natural-language queries over the platform ("occupancy
  next weekend?"), drafted actions (rate changes) with human approval.

## Standing rules

- Modular monolith until scale forces otherwise.
- Every feature meets the Definition of Done in `CLAUDE.md`.
- Anything that slips, slips to the *next* phase — Milestone 1 scope is fixed.
