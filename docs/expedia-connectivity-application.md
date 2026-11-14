# Expedia Connectivity (QuickConnect) — Technical Submission

Draft answers for the Expedia Group connectivity partner application, written
to be copied into whatever form Expedia sends. Same rule as the Agoda and
Booking.com submissions (`agoda-connectivity-application.md`,
`booking-com-connectivity-application.md`): every claim below is checkable in
this repository, and §10 says plainly what does not exist yet. An application
that oversells gets found out at certification, which is a worse place to be
found out than a form.

Drafted 2026-10-28. **Not yet filed.** Of the three OTA applications only
Agoda has gone out (case 105606752, 2026-08-13, no certification pack since).
Expedia goes second because its programme is the best documented of the four
and its certification is a scenario pack rather than a volume gate.

> **Before sending, fill in:** legal entity name and registration number,
> registered address, and a contact. Marked `‹fill in›` below. Do not guess
> any of them.

> **Known from the property's extranet (2026-08-13):** the pilot property's
> Expedia connection runs through **eZee Centrix — powered by Yanolja** with
> four services enabled. Expedia binds one connectivity provider per
> property; the switch is a cutover scheduled with Expedia, not a parallel
> run. The eZee connection stays in place until then.

**Applicant:** DeeHub — hotel platform (PMS + channel manager), Thailand
**Legal entity:** ‹fill in›
**First property to connect:** The Let's Chill Resort Pattaya @ Huayyai,
7 rooms across 2 room types, Expedia property ID **130144037**
**Production:** live on Google Cloud, `asia-southeast1` (Singapore)
**Contact:** ‹fill in›

---

## 1. What DeeHub is

A single system holding reservations, room inventory, rates and channel
distribution for small and mid-size Thai properties — 10 to 30 rooms is the
design centre. It is not a channel manager bolted onto a PMS or the reverse:
the availability the front desk sees and the availability pushed to a channel
are the same rows, read in the same query.

Multi-tenant from the first migration: an organization owns properties, and
every business table is scoped by organization. Adding a second hotel is data,
not deployment.

Since the Agoda submission (August 2026) the platform has also shipped a
direct booking site (book.deehubhotel.com, live since 2026-09-27, reading
availability live from the same inventory rows) and a Google Hotel Center
connector built on the same connector interface described in §2.

## 2. Connectivity architecture

### 2.1 The connector interface

Every channel implements one port, four required operations and one optional:

| Operation           | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `pushAri`           | Send availability, rates and stay restrictions                           |
| `fetchReservations` | Pull bookings since a timestamp, for channels without webhooks           |
| `parseWebhook`      | Verify and parse a pushed booking                                        |
| `testConnection`    | Prove credentials and reachability without changing anything             |
| `pushCatalog`       | Optional: describe room types and rate plans to channels that require it |

No channel-specific logic exists anywhere in the reservation or inventory
modules — a rule the project has held from its first architecture document.
Expedia's auth scheme, payload shapes and quirks would live entirely behind
this interface, as Google's already do.

A reference connector (an in-house "Mock OTA" with its own API and UI) passes
a contract test suite that every connector must also pass, and the Google
Hotel Center connector is the first non-mock implementation of the port.

### 2.2 How QuickConnect maps onto the port

Reading Expedia's published QuickConnect (EQC) family against the port, as
we understand it today — Expedia's current documentation is the authority:

| Expedia API                       | Port operation      | Status                              |
| --------------------------------- | ------------------- | ----------------------------------- |
| Availability & Rates (AR)         | `pushAri`           | Built; payload translation needed   |
| Booking Retrieval (BR)            | `fetchReservations` | Built; payload translation needed   |
| Booking Notification (BN)         | `parseWebhook`      | Built; payload translation needed   |
| Booking Confirmation (BC)         | `acknowledge`       | **Not in the port yet** (§2.5, §10) |
| Product API (room / rate catalog) | `fetchCatalog`      | **Not in the port yet** (§10)       |

### 2.3 ARI is absolute, never incremental

`pushAri` sends the state a channel should hold — sellable units, rates and
restrictions per night — not a delta.

This is deliberate and it is what makes at-least-once delivery safe. A retry
after a timeout cannot double-apply anything, and a message that arrives twice
leaves the same result as one that arrives once. Incremental updates make
recovery from a partial failure a reconciliation problem; absolute updates make
it a re-send.

### 2.4 Change detection and delivery

1. A booking, cancellation, rate change or allotment edit writes its domain
   event to an **outbox table in the same database transaction** as the change
   itself. There is no window in which the change is committed and the event is
   lost.
2. A relay picks events up and enqueues per-channel push jobs.
3. Failures are retried with backoff and eventually dead-lettered rather than
   dropped, and the attempt count travels with the job.
4. Operators can force a full re-push for a property at any time, which runs
   inline and needs no queue — the recovery path when anyone doubts what a
   channel is holding.

Target propagation: **under 60 seconds** from change to channel, which is the
exit criterion the project set for itself before any OTA was involved.

### 2.5 Inbound bookings, and the confirmation Expedia expects

Both directions are supported: webhook push and scheduled pull.

- The **raw body is verified before it is parsed**, over the exact bytes
  received. An invalid signature is rejected as unauthenticated and nothing is
  written.
- Every inbound booking is **stored raw before mapping** and never deleted, so
  a mapping bug is recoverable from the original payload rather than from a log.
- Deduplication is a **unique index on (channel, external reservation id)** —
  a database constraint, not application logic, so a redelivery cannot create a
  second booking even under concurrency.
- A payload that cannot be parsed is stored for human review and alerts, rather
  than being discarded or retried forever.

Expedia delivers a booking and expects a **confirmation back per booking**,
and redelivers until it gets one. The port today has no operation for that.
The design is written (`ota-expansion-plan.md` §5.1): a fifth port operation
`acknowledge`, called by the delivery pipeline for every channel, with
`acknowledged_at` and `acknowledgement_error` recorded on the inbound row and
an index over unacknowledged rows so a stuck confirmation is visible rather
than silent. The dedupe index already makes redelivery harmless;
acknowledgement is what stops it being endless. It is built with the first
channel that needs it, which would be Expedia.

## 3. How overbooking is prevented

The guarantee is enforced by PostgreSQL, not by application code:

```sql
check (booked >= 0 and booked <= allotment)
```

Availability is a count per room type per night. Taking a booking locks the
affected dates in a fixed order and increments `booked`; the constraint refuses
the increment that would exceed the allotment, and the transaction fails. Two
requests for the last room in the same instant produce one booking and one
refusal — there is no interleaving in which both succeed.

Physical rooms exist for assignment and housekeeping only and never affect what
is sellable, so a room being dirty, out of order or unassigned cannot silently
change what a channel is told.

Conflict rule when a channel and the front desk disagree: **never oversell.**
The lower number wins and the difference is pushed back out.

## 4. Rates and restrictions

- Rates per room type, rate plan, date and occupancy.
- Derived rate plans (a fixed offset from a parent) are resolved in a single
  database view, so the booking path, the ARI push and the rate grid cannot
  disagree about a price.
- Stay restrictions supported: stop-sell, minimum stay, maximum stay, closed to
  arrival, closed to departure.
- **Per-channel rate multiplier** per rate plan, in basis points so the
  arithmetic stays in integers: a property can sell higher on Expedia than
  direct without a second rate grid.
- Each ARI rate carries both the net amount and the all-in amount (service
  charge and VAT applied exactly as a booking applies them), so a channel that
  shows guests a final price shows the one the hotel will ask for.
- **Cancellation policy per rate plan** (notice hours, refund percentage),
  frozen onto every booking at the moment it is taken.
- **The price a guest is quoted is frozen onto the booking.** Later rate changes
  never reach a booking already taken.

Not built: a promotions engine. Expedia promotions would be managed in the
extranet, not through DeeHub (§10).

## 5. Dates and money

Thailand-first, and specific about it:

- A hotel night is a **calendar date in the property's own timezone**, never a
  UTC timestamp. This is the detail foreign systems most often get wrong, and it
  distorts a whole month of room-night figures when they do.
- Currency is per property, stored in minor units as integers. No floating point
  touches money anywhere in the system.
- VAT and service charge are per-property settings, and whether quoted rates
  include them is explicit rather than assumed.

Expedia Collect versus Hotel Collect: inbound bookings carry the total as the
channel states it and are mapped to a folio; who collected the money is a
property of the booking, not of the rate. We would expect the certification
pack to say which models the property must support and would map each to a
folio posting rather than invent a rule.

## 6. Security

| Concern             | Answer                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Channel credentials | **AES-256-GCM** at rest, versioned ciphertext format. Write-only: never returned by the API, the UI or the audit trail |
| Secrets             | Google Secret Manager; never in source, in Terraform state, or in a pull request                                       |
| Database            | Private IP only, no public endpoint, reachable only from inside the VPC                                                |
| Transport           | TLS everywhere; the API is HTTPS-only                                                                                  |
| Outbound IP         | Fixed NAT egress IP, so Expedia can allow-list the sender                                                              |
| Authentication      | JWT access tokens with refresh rotation; capability-based authorisation per role                                       |
| Card data           | **None stored.** Payments go through a licensed Thai gateway; DeeHub never holds a PAN                                 |
| Audit               | Every state change records who did it and when, readable in the dashboard                                              |
| Tenant isolation    | Organization scoping on every business table and every query                                                           |

If Expedia's booking payloads carry virtual card details for Expedia Collect,
we would need to know the handling requirements before certification; the
current position is that no card data is persisted anywhere, and we would keep
it that way by passing such fields through to the gateway or not storing them.

## 7. Reliability and operations

- **Google Cloud Run** in `asia-southeast1`, Cloud SQL for PostgreSQL, Redis for
  the sync queue.
- Automated deploys on merge: lint, typecheck, roughly **1,000 automated API
  tests** (unit, integration against a real PostgreSQL, and HTTP end-to-end)
  followed by about **140 browser tests** driving the dashboard in Chromium,
  and database migrations — all gating the release.
- Error reporting and alerting on API errors, job failures and database
  capacity.
- A scheduled maintenance pass reconciles inventory against reservations and
  reports drift, so a booking-path bug surfaces as an alert rather than as a
  guest arriving at a full hotel.

## 8. Certification readiness

What we would need to start: EQC endpoint documentation, message schemas, the
authentication scheme, a test environment, a test property, and the
certification scenario pack.

What we would deliver: a connector implementing the interface in §2.1, passing
the same contract suite the reference and Google connectors pass, plus
Expedia's certification scenarios as their own suite; and the `acknowledge`
operation with its schema and tests, since Booking Confirmation is a
certification requirement.

**Estimate: 2 weeks from receiving the specification to certification-ready**
for AR, BR, BN and BC. Product API (catalog) is a further week if it is
required for certification rather than optional. The work is payload
translation plus one new port operation. Inventory arithmetic, overbooking
prevention, retry, dead-lettering, mapping and inbound handling are built and
tested.

## 9. Cutover for the first property

1. Expedia confirms DeeHub as a connectivity provider and issues test
   credentials.
2. Connector certified against the scenario pack.
3. The property maps each Expedia room type and rate plan to its DeeHub
   equivalents; activation is refused until every active room type is mapped.
4. On the agreed date Expedia moves the property from eZee Centrix to DeeHub.
   DeeHub pushes a full ARI immediately on activation, so the property's
   extranet shows DeeHub's numbers from the first minute.
5. Any booking Expedia delivered to eZee before the cutover and that is not yet
   in DeeHub is entered at the desk, from the extranet, before activation.

## 10. What does not exist yet

Stated because certification finds it anyway:

1. **No production OTA connector.** The framework is proven against the Mock
   OTA and the Google Hotel Center connector (a metasearch, outbound only, with
   no inbound bookings). Expedia would be the first OTA with inbound bookings.
2. **One live property.** The Let's Chill Resort, onboarded in August 2026.
   DeeHub is an early-stage platform and does not claim a portfolio it does not
   have. If the programme has a minimum property count we do not meet, we would
   rather be told now than discover it at certification.
3. **Booking Confirmation (`acknowledge`) is designed, not built** (§2.5).
4. **No catalog fetch** — mapping is by typed external identifiers today, with
   activation refused on missing mappings. The design for fetching the
   channel's catalog into a dropdown exists (`ota-expansion-plan.md` §5.2).
5. **No promotions engine** (§4).
6. **Event-driven sync is not switched on in production yet.** The deployment
   currently runs without the always-on worker because there is nothing to
   push to; the Google feed is drained by a scheduled job instead. It is a
   configuration flag and the infrastructure for it is written and in version
   control. It goes on before any Expedia connection is activated.
7. **No ISO 27001 or SOC 2.**
8. **A small team.** One engineer-founder. This is a reason to be precise about
   what is built rather than to imply otherwise.

---

## Answers to questions Expedia usually asks

**How often do you push availability and rates?**
On change, within seconds, via the outbox relay. A full re-push can be forced
at any time, and a nightly reconciliation catches anything the event path
missed.

**How do you handle a failed push?**
Retry with backoff, then dead-letter with the attempt count and the last error.
Because ARI is absolute, a later successful push corrects everything a failed
one would have carried — no repair queue is needed.

**How do you confirm bookings?**
Once `acknowledge` is built (§2.5): every inbound booking is confirmed back
after it is committed, the confirmation is recorded on the inbound row, and
unconfirmed rows past a threshold alert. Until then, honestly: we do not, which
is why it is in §10 rather than implied.

**How do you avoid duplicate bookings from redelivered notifications?**
A unique index on (channel, external reservation id). The second insert fails at
the database.

**What happens if a room type is not mapped?**
The channel cannot be activated. An active channel with a missing mapping does
not fail loudly — it silently skips that room type, the OTA keeps selling
whatever it last heard, and the first symptom is a guest arriving at a full
hotel. Activation is refused until every active room type is mapped, and adding
a new room type flags the channel in the UI.

**Can a property use DeeHub for the front desk while another channel manager
holds the Expedia connection?**
Yes, and that is the current state of our first property. Expedia binds one
connectivity provider per property, so the switch is a scheduled cutover
coordinated with Expedia rather than a parallel run.

**Support model?**
Founder-led, Thai and English, business hours Asia/Bangkok, with alerting on
the paths that matter (booking creation, channel push failure, database
capacity). We would agree a realistic response commitment rather than claim
24/7 at this stage.
