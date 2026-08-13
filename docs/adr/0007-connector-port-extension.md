# ADR-0007: The connector port grows; adapters never gain private operations

- **Status:** Proposed — takes effect with the first connector that needs it
- **Date:** 2026-08-13
- **Decider:** AI (CTO role), pending founder objection

## Context

`ChannelConnector` has four operations (`pushAri`, `fetchReservations`,
`parseWebhook`, `testConnection`). They were sufficient for the Mock OTA, which
is unsurprising: we designed the Mock OTA too.

Reading what real OTAs require against what the port offers turns up three
gaps (`ota-expansion-plan.md` §5):

- **Acknowledgement.** Expedia and Trip.com redeliver a booking until it is
  confirmed back. There is no operation for it and no column recording it.
- **Catalogue.** Mapping means typing an `external_room_id` by hand. A typo is
  accepted, activation succeeds, and that room type is never sold — the exact
  failure mode we refused activation to prevent.
- **Capabilities.** `AriNight` assumes every channel accepts `maxStay`, CTA and
  CTD and takes rates and availability in one call. They do not.

When the first such channel arrives, there are three ways to absorb it:

1. **Handle it inside the adapter, invisibly.** The Expedia adapter confirms
   bookings itself inside `fetchReservations`.
2. **Branch at the call site.** The delivery pipeline checks the channel type,
   or checks whether an optional method exists, before calling it.
3. **Extend the port**, so every adapter answers the same questions.

Option 1 is the tempting one and the dangerous one. A confirmation performed
invisibly has no row recording it, no retry when it fails, and no way for an
operator to see that a booking arrived but was never confirmed. The failure is
silent and the symptom is the OTA redelivering forever.

Option 2 reintroduces exactly what the master prompt forbids: business modules
that know which OTA they are talking to. `if (type === 'EXPEDIA')` in the
delivery pipeline is the first sentence of the story that ends with OTA names
in the reservation module.

## Decision

**The port grows. Adapters never gain operations the port does not name.**

Concretely, when the first channel requires them:

- `acknowledge(ctx, reservation): Promise<void>` becomes the fifth operation,
  **required of every adapter and called for every inbound booking.** A channel
  needing no confirmation returns immediately. There is no capability flag for
  this and no branch at the call site — a no-op is cheaper than a conditional
  that can be got wrong.
- `fetchCatalog(ctx): Promise<ChannelCatalog>` becomes the sixth, serving the
  mapping UI. Fetched on demand, **never cached in the database** — a stale
  catalogue disagreeing with the OTA is worse than a fetch on screen open, and
  there is no invalidation signal.
- `capabilities` becomes a readonly descriptor **on the connector, declared in
  code, not a column.** A capability is a property of the adapter; a copy in
  the database drifts from it the day the adapter changes. Only ARI assembly
  reads it, and only to shape a payload.
- Acknowledgement state is persisted: `channel_reservations.acknowledged_at`
  and `acknowledgement_error`, with a partial index so an unacknowledged
  booking is a query and not an archaeology exercise.
- **The contract suite grows with the port.** An operation nobody's test
  exercises is an operation the next adapter implements wrongly, so the Mock
  OTA implements each one for real rather than stubbing it.

**Nothing is built speculatively.** Each item lands with the first real channel
that needs it. This ADR fixes the shape, not the schedule — its purpose is that
the shape is decided before the deadline pressure of a certification window,
not during it.

## Consequences

- Every existing adapter must implement each new operation when it is added.
  With two adapters (Mock OTA and the first real one) that is cheap; it is the
  reason to decide this now rather than at four.
- The Mock OTA keeps growing to stay a faithful harness. That is its job.
- A no-op `acknowledge` on channels that need none looks like dead code to
  anyone reading one adapter in isolation. It is not: it is what keeps the
  branch out of the delivery pipeline. This ADR is the answer when someone
  proposes deleting it.
- Adding an operation is a breaking change to the port, deliberately — the
  compiler names every adapter that has not answered the new question.
- Optional methods (`acknowledge?`) are rejected for the same reason: they move
  the question from compile time to a runtime check somebody forgets to write.
