# ADR-0010: Google Hotels is a channel, and a deployment without Redis still syncs

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decider:** AI (CTO role), on the founder's ask to put the hotel's lowest price on Google

## Context

A pilot hotel already appears on Google Hotels with an "official site" price —
fed by the PMS it is leaving. Google takes rates only from a **connectivity
partner** (a PMS, channel manager or booking engine integrated with Hotel
Center), never from a hotel directly, so for DeeHub's price to be the one on
Google, DeeHub must be that partner: a Hotel List Feed, a landing-page
template, a property-data message and ARI pushes, authenticated by the
sender's IP. And the price shown must match the booking page to the satang —
Google audits it.

Two design questions followed. Where does the Google integration live? And
how does a change reach Google when the deployment has switched the
event-driven sync engine off to save its Redis and always-on worker?

## Options

**Where it lives.**

1. A `google` module of its own, with its own push loop and mapping tables.
2. A `ChannelConnector` of type `GOOGLE_HOTEL`, using the channel framework's
   mappings, ARI assembly, retries, sync log, forced sync and audit — with the
   port widened by one optional method (`pushCatalog`) for the property data
   Google needs before it will price a room.

**How it syncs without Redis.**

1. Turn `enable_channel_sync` on: Memorystore plus a worker, ~$80/month, for a
   product with one pilot.
2. Record what the relay would have enqueued in a table (`ari_sync_requests`)
   and have the maintenance job — already running every few minutes — push it
   through the same `PushAriUseCase` the worker uses.

## Decision

Option 2 both times.

Google is a connector. Everything Google-shaped — the three OTA-flavoured XML
documents, the Transaction message, `HotelCode` = property id, IP-based auth
meaning no credentials — sits in one adapter; Inventory and Reservations know
nothing of it, as the master prompt requires. It is outbound only: Google
sends the traveller to our booking page, and the booking arrives as `DIRECT`.
Its external ids are ours (`autoMap`: room type code → RoomID, rate plan
code → PackageID), because the Transaction message we send _defines_ them.

The ARI port gains `grossMinor`: every rate carries the all-in price computed
by `computeBreakdown`, the function the checkout uses, so the number Google
shows is the number the guest pays. A desk-only plan (`sellOnline = false`)
is never mapped, so it can never become the lowest price Google shows.

Without Redis the relay writes `ari_sync_requests` instead of throwing;
`DrainAriRequestsUseCase` groups by channel and room type, unions the date
spans (the debounce), pushes, and after ten failed rounds abandons the rows
and flags the channel. Minutes of lag instead of seconds, for a deployment
that chose not to pay for seconds. With Redis present nothing changes.

Because Google allow-lists the sender's address, the API and the maintenance
job leave through Cloud NAT on one reserved IP (`network.tf`), which also
routes every other outbound call — a few dollars a month.

## Consequences

- The channel list, mappings, sync log and forced sync in the dashboard work
  for Google unchanged; one extra button maps everything under our own codes.
- `pushCatalog` is called on activation and before a forced sync; its failure
  is recorded on the channel, never thrown across an activation.
- The Hotel List Feed is the one cross-tenant read in the system, guarded by
  an unguessable key; the landing-page file is uploaded by hand once and
  never per property (`/g/{hotelId}` on the booking site resolves the id).
- DeeHub's acceptance as a connectivity partner is Google's decision and takes
  weeks; everything here is testable against a fake Hotel Center before that.
