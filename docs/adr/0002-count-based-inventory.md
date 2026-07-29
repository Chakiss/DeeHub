# ADR-0002: Count-based allotment inventory

- **Status:** Accepted
- **Date:** 2026-07-29
- **Decider:** Founder

## Context

Room availability can be modeled two ways:

1. **Count-based allotment** — availability is a number of sellable units per
   room type per night.
2. **Physical-room derived** — availability is computed from assignments of
   reservations to physical rooms.

Every major OTA (Agoda, Booking.com, Expedia, Trip.com) exchanges
availability as _counts per room type per date_. A channel manager that
derives counts from physical assignments must constantly reconcile the two
models and makes controlled overselling nearly impossible to express.

## Decision

- **Inventory = per room type, per night, per property:** `allotment`
  (sellable units), `booked` (confirmed units), plus controls
  (`stop_sell`, `min_stay`, `closed_to_arrival`, `closed_to_departure`).
- Availability = `allotment − booked`, never derived from physical rooms.
- **Physical rooms** exist as a separate module for room assignment,
  housekeeping, and front-desk operations. Assignment happens at/near
  check-in and never affects OTA availability.
- Booking a reservation atomically increments `booked` with an optimistic /
  row-locked update that rejects when it would exceed `allotment` — this is
  the overbooking guard and must be a single SQL statement, not
  read-then-write.

## Consequences

- Direct mapping to OTA ARI (Availability, Rates, Inventory) messages —
  the sync engine pushes counts as-is.
- Overselling strategies (e.g., allotment > physical rooms) become a simple
  business setting.
- Requires discipline: nothing outside the Inventory module may write
  `booked`; all changes flow through domain events from Reservations.
- A nightly reconciliation job should verify `booked` against confirmed
  reservations (self-healing against drift).
