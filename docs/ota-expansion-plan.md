# OTA Expansion — beyond Agoda

Written 2026-08-13, after the Agoda connectivity application
(`agoda-connectivity-application.md`) was drafted and the obvious next question
was asked: what about everyone else?

This plan covers Booking.com, Expedia, Trip.com and Airbnb. It refines
roadmap Phase 5's one-line "More connectors" into something schedulable.

---

## 1. Business goal

Every channel a property can sell through is revenue for that property and an
argument in the next sales conversation. A single-channel channel manager is
not a channel manager.

The constraint that shapes everything below: **the long pole is partner
approval, not code.** A connector is roughly two weeks of payload translation
against a specification. Getting the specification takes months and is a
process no amount of engineering shortens. The plan is therefore built to run
the slow track (applications) in the background while the fast track (code)
waits for inputs it cannot fabricate.

## 2. What is already true

Not requirements — facts, checked in this repository, so the plan does not
re-plan them:

- `ChannelConnector` is a four-operation port with no OTA names in any business
  module (`channels/domain/channel-connector.ts`).
- `ConnectorRegistry` resolves adapters by `ChannelType` at runtime; adding a
  channel is registering one more class.
- `CHANNEL_TYPES` and the `channels.type` check constraint already list
  `BOOKING_COM`, `EXPEDIA`, `TRIP_COM`, `AIRBNB` and `DIRECT`. No migration is
  needed to create a channel of any of them.
- Mapping tables (`channel_room_type_mappings`, `channel_rate_plan_mappings`)
  are channel-agnostic, uniquely indexed both ways, and activation is refused
  while any active room type is unmapped.
- Inbound dedupe is a unique index on `(channel_id, external_reservation_id)`.
- The contract suite (`connector-contract.test.ts`, 331 lines) is written to be
  run against any adapter, not just the Mock OTA.

The Mock OTA connector is **238 lines**. That is the honest size of an
integration once the specification is in hand.

## 3. The channels, and what each actually costs

Programme details change; verify against each provider's current partner
documentation before applying. Effort is engineering time **after** a
specification and sandbox exist.

| Channel         | Route in                         | Effort  | The real obstacle                                                                  |
| --------------- | -------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| **Agoda**       | Connectivity partner application | 1–2 wks | In progress. Thailand priority, fastest expected answer                            |
| **Booking.com** | Connectivity Partner Programme   | 2–3 wks | Provider onboarding + a certification scenario pack; content API separate from ARI |
| **Expedia**     | QuickConnect (EQC)               | 2 wks   | Pull-based booking retrieval with a **mandatory confirmation** back per booking    |
| **Trip.com**    | Partner application              | 2 wks   | ARI push + order pull + confirm, shaped like Expedia                               |
| **Airbnb**      | Selective API partnership        | 3–4 wks | Approval is gated and often closed; the data model does not fit ours (§6)          |

**What the pilot property runs today (seen in its extranets, 2026-08-13):** all
four channels connect through **eZee Centrix, by Yanolja** — Agoda via YCS
"managed by a channel manager", Expedia via eZee Centrix with four services
enabled, Trip.com under connected-property ID `134351351`, and Booking.com with
a connection still **pending**. Two consequences:

- The incumbent is one product, not four. Replacing it means matching it on
  every channel the property sells through, not on one.
- Booking.com permits only one pending connection request at a time, so a
  cutover there is sequenced by the property, not by us.

The same screens are the best specification we have of what a Thai property
expects from a channel manager, and two features come straight off them: a
per-rate-plan **rate multiplier** (`channel-markup-plan.md`) and a **fetch
mapping** button (ADR-0007 §5.2).

**Direct is not on this list.** `DIRECT` exists in the enum to attribute a
booking's origin, and the public booking API already writes reservations
against the same inventory rows the front desk reads. There is nothing to push
to a channel that is this database. What direct selling still lacks is a
guest-facing page and rate limiting on the public routes — a Phase 3 item, not
a connector.

## 4. Sequencing

The applications are the schedule. The code fits between them.

1. **Now — apply to Booking.com in parallel with Agoda.** Nothing about waiting
   for Agoda's answer helps the Booking.com queue, and the technical submission
   already written is reusable almost verbatim. Two applications outstanding
   costs nothing but the writing.
2. **On the first certification pack arriving** — build that adapter, and take
   the port extension in §5 at the same time, informed by a real specification
   rather than guessed from three remembered ones.
3. **Expedia and Trip.com after the first OTA is live in production**, not
   before. A second integration built against an unproven pipeline debugs two
   things at once.
4. **Airbnb: not scheduled.** See §6.

## 5. The port needs three things it does not have

Discovered by reading what Expedia and Trip.com require against what the port
offers. These are not built yet and should not be built speculatively — they
land with the first channel that needs them. Recorded now so nobody designs
around their absence. Rationale in
[ADR-0007](adr/0007-connector-port-extension.md).

### 5.1 `acknowledge` — the missing fifth operation

Expedia and Trip.com deliver a booking and expect a confirmation back. Until
one arrives they redeliver, indefinitely. The port has no operation for this,
and there is nowhere in `channel_reservations` to record that it happened.

- Port: `acknowledge(ctx, reservation): Promise<void>`, called by the delivery
  pipeline for **every** channel. A channel that needs no confirmation returns
  immediately. No `if (connector.acknowledge)` at the call site.
- Schema: `channel_reservations.acknowledged_at timestamptz` and
  `acknowledgement_error text`, plus an index for unacknowledged rows so a
  stuck confirmation is visible rather than silent.
- The dedupe index already makes redelivery harmless; acknowledgement stops it
  being endless.

### 5.2 `fetchCatalog` — mapping without typing identifiers

Mapping today means typing an `external_room_id` by hand into the channel
screen. A wrong character is accepted, activation succeeds, and the room type
is silently never sold. Every OTA exposes its own room and rate catalogue.

- Port: `fetchCatalog(ctx): Promise<ChannelCatalog>` — rooms and rate plans as
  the channel lists them.
- API: `GET /channels/:id/catalog`, consumed by the mapping screen to turn free
  text into a dropdown.
- **Not cached in the database.** A stale catalogue that disagrees with the OTA
  is worse than a fetch on screen open, and there is no invalidation signal.

### 5.3 `capabilities` — what this channel can actually be told

`AriNight` assumes every channel accepts every restriction. They do not: some
reject `maxStay`, some take rates and availability through separate endpoints,
all have different batch limits and rate limits.

- Port: a readonly `capabilities` descriptor on the connector, read by ARI
  assembly to shape the payload.
- **Declared in code, not stored in a column.** A capability is a property of
  the adapter; a database copy drifts from it the day the adapter changes.
- Kept deliberately thin until a second real channel exists — a capability
  system designed against one OTA is a guess.

### 5.4 Not doing yet: cancel and modify as first-class intents

`InboundReservation.externalStatus` is an opaque string, and inbound handling
treats a cancellation as a status to interpret. That is adequate for one
channel and will not stay adequate. It is deliberately left until two real
channels disagree about it, because the right shape is visible then and only
guessable now.

## 6. Airbnb does not fit, and that is architectural

Airbnb sells **listings**, not an allotment of interchangeable units. Its
calendar is per listing per night, available or not. ADR-0002 makes
availability a count per room type per night and keeps physical rooms out of
the sell path entirely — deliberately, because every OTA in §3 speaks counts.

Bridging the two means either mapping each physical room to its own Airbnb
listing (which puts physical rooms back into the sell path, against ADR-0002),
or mapping a room type to one listing (which sells one unit of a five-unit room
type). Neither is a payload translation; both are a second inventory model.

Combined with partnership access that is gated and frequently closed, the
recommendation is to leave Airbnb out of the roadmap until a property asks for
it with revenue attached. It is the one channel where the honest answer is
"not without a design we have not done".

## 7. Test cases

Every adapter is certified by the existing contract suite before it is
registered — that is the point of the suite. Per-adapter additions:

- Idempotent `pushAri`: the same state pushed twice leaves one result (already
  in the suite).
- A partial rejection reports counts rather than failing the batch.
- A 5xx throws so BullMQ retries; an auth failure throws rather than reporting
  success.
- Webhook signature verified **before** parsing, over raw bytes.
- Redelivery of an acknowledged booking creates no second reservation.
- `acknowledge` is called for every inbound booking and is idempotent.
- Restrictions the channel does not support are omitted, not silently sent.
- The channel's sandbox certification scenarios, whatever they are, as their
  own suite alongside the contract suite.

## 8. Risks

| Risk                                                               | Mitigation                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| No application is accepted at all                                  | Direct booking engine is the fallback revenue path and depends on nobody's approval                       |
| Certification arrives while production sync is still off           | `enable_channel_sync` and the paused maintenance job must be resolved before any activation — see roadmap |
| Two channels sell the last room in the same second                 | Already handled: the `booked <= allotment` constraint refuses one of them, and ARI is absolute            |
| A capability system designed from memory of specs we have not read | Defer §5.3 until a real specification is in hand                                                          |
| One engineer, four integrations                                    | Strictly sequential, each live in production before the next starts                                       |
| Agoda binds one connectivity provider per property                 | Cutover is scheduled with the OTA, never a parallel run                                                   |

## 9. Future improvements

- A shared HTTP client for adapters with per-channel rate limiting and retry
  taxonomy, once three adapters have duplicated it twice.
- Channel-level allotment splitting (`channel_id` on inventory), noted as a
  future extension in `database.md` — only if a property asks to cap what one
  OTA can sell.
- A connector conformance report in the dashboard: which operations a channel
  supports, when it was last certified, what its last error was.
