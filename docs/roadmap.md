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
  be cleared for a date range as well as set, and a plan can be priced as an
  offset from another so one edit reprices the whole horizon.
- **Front desk**: physical rooms, housekeeping status, Stay View, room
  assignment, check-in and check-out, and a guest account per booking —
  charges, payments, refunds, voids and a running balance, with what is still
  owed shown at check-out. Reservations can be taken at the desk
  (manual booking), an unstarted stay can have its dates, room type, rate plan
  or occupancy changed, and a stay already under way can have its departure
  moved in either direction — extended, or cut short when a guest leaves early.
- **Guests**: profiles and stay history, and a way to fold two profiles into
  one when the same person booked twice under different details.
- **Reporting**: occupancy, ADR and RevPAR looking back, and pickup looking
  forward — what has been taken for the nights ahead since a week ago.
- **Channels**: created, credentialed, mapped and activated from the
  dashboard rather than by hand-written SQL, with a connection test and a
  forced full push that works even without the always-on worker.
- **Notifications**: booking confirmations and cancellations to guests in
  Thai or English, and an alert to the desk when a channel sells a room —
  with a delivery log showing what was sent and what was not.
- **Account recovery**: self-service `forgot-password` / `reset-password` —
  a single-use link that expires in an hour, never says whether an account
  exists, and revokes every session and every other live link when it is used.
  Needs `admin_web_url` set in Terraform before it works in production.
- **Operations**: Thai UI, the audit trail readable in the dashboard,
  alerting and error reporting, operator-driven password reset, team
  administration with a one-time credential, and a password change that
  revokes every other session.

**What a pilot property still cannot do**, in the order it will hurt:

1. **Sell through an OTA.** Everything up to the adapter is built: the port,
   the registry, the contract suite the Mock OTA passes, mapping, ARI assembly,
   retry and dead-lettering, inbound webhooks, and now test-connection and a
   forced full sync that runs inline — so a deployment with
   `enable_channel_sync` off can push manually without Redis. What is missing
   is a REAL connector, which needs Agoda's certification pack (endpoints,
   schemas, a test account). Event-driven sync still needs
   `enable_channel_sync`: Redis and an always-on worker, roughly $80/month on
   top of the current ~$22.
2. **Deliver a confirmation to a guest.** Mail goes out for real — proved end
   to end through the production path — but the Resend account has no verified
   domain, so `onboarding@resend.dev` is the only working sender and it
   delivers only to the account owner. Guest confirmations fail with the
   provider's reason on the row until a domain is verified. Nothing in the code
   changes when it is.
3. **Confirm a booking instantly.** Messages are sent by the maintenance job,
   now every ten minutes, so a confirmation arrives within ten minutes rather
   than seconds. The always-on worker sends within seconds but costs the same
   ~$80/month as channel sync.

## Phase 3 — First Real OTA + Booking Engine (Months 4–6)

- First real connector (**Agoda** first — Thailand priority; then
  Booking.com), certification process.
- Reservation delivery inbox: channel bookings auto-ingested, deduplicated,
  and mapped.
- Direct Booking Engine v1: availability search, book, basic payment
  (deposit via Omise/Stripe — payments enter the roadmap here).
- Rate Plans v2: ~~derived rates (percentage/amount off parent)~~ **done** — a
  plan can be priced as an offset from another, resolved in one view so the
  booking path, the ARI push and the grid cannot disagree. **Promotions
  remaining**: a bounded discount (stay window, booking window, minimum stay)
  needs a rule for what happens when two of them match, which is a commercial
  decision rather than a technical one.
- ~~Thai UI translation.~~ **Done** — pulled forward, the whole dashboard is
  bilingual.

## Phase 4 — PMS Operations + CRM (Months 6–9)

Mostly delivered early; what is left is listed as **remaining**.

- Front desk: ~~room assignment, check-in/out, housekeeping status board,
  folio basics~~ **done**. Each booking has an account: room nights derived
  from its frozen prices, extra charges, payments and refunds by method, and a
  balance. **Remaining**: a posted-charge ledger, which is what a night audit
  needs to freeze a day's revenue — this reports what is owed now, not what was
  owed at midnight.
- Guests → CRM: ~~profiles, stay history, dedupe/merge~~ **done**. A returning
  guest booked under a different spelling is found by phone, email or name, and
  folded into the profile the hotel keeps — never automatically.
- Notifications: ~~email/LINE confirmations to guests, alerts to staff~~
  **done** — booking confirmed, booking cancelled, and a channel booking
  alerting the desk, with a real provider wired. **Remaining**: a verified
  sending domain, which is an account task rather than a code one. Without one
  only the Resend account owner receives anything; everyone else's row shows
  the provider's refusal.
- Reporting v1: ~~occupancy, ADR, RevPAR, pickup~~ **done**. Pickup needed
  booking-date history, which live rows do not keep, so the maintenance job now
  freezes on-the-books figures once per business date. History starts from the
  first snapshot and cannot be backfilled.

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
