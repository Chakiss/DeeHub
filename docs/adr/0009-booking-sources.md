# ADR-0009: Where a booking came from is a per-property list, not an enum and not a channel

- **Status:** Accepted
- **Date:** 2026-09-22
- **Decider:** AI (CTO role), on a pilot hotel's complaint

## Context

A pilot hotel's front desk keys in every OTA booking by hand — no connector
is live yet — and the booking form offered only Walk-in, Phone, Email and
Direct. There was nowhere to say a booking came through Agoda, and so nothing
to report "how much did Agoda bring in" from. The PMS it compares us to asks
two questions: a category (Walk In / Booking Engine / OTA / Travel Agent) and
a "business source" (Agoda, Booking.com, an agent by name).

`reservations.source` already held the category. The question was where the
second answer lives.

## Options

1. **Widen the enum**: add `AGODA`, `BOOKING_COM`, … to `reservations.source`.
   Every OTA name lands in the reservations module, which the master prompt
   forbids; a travel agent is a name the hotel makes up, not a value we can
   list; and each new value is a CHECK constraint migration plus four
   hand-kept copies of the list.
2. **Use `channels`**: create an Agoda channel row and point bookings at it.
   A channel is a connector — credentials, mappings, a sync queue, one ACTIVE
   per type. A label for hand-keyed bookings would either be a channel the
   sync engine tries to push to, or a status that means "not really a
   channel". "Travel Agent: Bangkok Tours" is not a connector at all.
3. **A `booking_sources` table per property**, referenced by the reservation.

## Decision

Option 3. `reservations.source` stays the category and gains `TRAVEL_AGENT`.
`booking_sources` holds the names — kind `OTA` or `TRAVEL_AGENT`, active or
retired, never deleted because bookings point at them. An OTA or
TRAVEL_AGENT booking keyed by hand must name one of the matching kind; other
categories may not.

`booking_sources.channel_type` ties a label to a connector type. When a
connector is switched on, the bookings it delivers land under the same label
the desk has been using by hand, so a report groups by one column whether the
booking came through the extranet or the API. A connector delivering a
booking for an OTA whose label the hotel retired still succeeds — the channel
is the authoritative answer there, the label a courtesy.

Every property starts with the usual OTAs (Agoda, Booking.com, Expedia,
Trip.com, Airbnb, Traveloka); the migration backfills existing properties,
the seed and an "add defaults" endpoint cover the rest.

## Consequences

- One select on the booking form with three groups: plain categories, OTAs,
  agents. Choosing "Agoda" sets both fields.
- Reporting by OTA becomes possible before any connector exists, and stays
  consistent after one does.
- Hand-keyed OTA bookings are still priced from the property's own rate plans,
  not at what the OTA sold the room for. That is a separate gap
  (`channel-markup-plan.md` §5 applies only to connector deliveries).
- Traveloka has no `CHANNEL_TYPES` entry, so its label has no `channel_type`
  until a connector for it exists.
