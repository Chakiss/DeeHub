# Agoda Connectivity Partner — Technical Submission

Draft answers for the connectivity partner application, written to be copied
into whatever form Agoda sends. Every claim below is checkable in this
repository, and the section at the end says plainly what does not exist yet —
an application that oversells gets found out at certification, which is a worse
place to be found out than a form.

**Applicant:** DeeHub — hotel platform (PMS + channel manager), Thailand
**First property to connect:** The Let's Chill Resort Pattaya @ Huayyai,
Agoda property ID **87305361**, 7 rooms across 2 room types
**Production:** live on Google Cloud, `asia-southeast1` (Singapore)

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

## 2. Connectivity architecture

### 2.1 The connector interface

Every channel implements one port with four operations:

| Operation           | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `pushAri`           | Send availability, rates and stay restrictions               |
| `fetchReservations` | Pull bookings, for channels without webhooks                 |
| `parseWebhook`      | Verify and parse a pushed booking                            |
| `testConnection`    | Prove credentials and reachability without changing anything |

No channel-specific logic exists anywhere in the reservation or inventory
modules — a rule the project has held from its first architecture document.
Agoda's auth scheme, payload shapes and quirks live entirely behind this
interface.

A reference connector (an in-house "Mock OTA" with its own API and UI) is
already built and passes a contract test suite that every future connector must
also pass. It exists so that the framework is proven end to end before a real
OTA is involved, and it stays as a permanent integration harness.

### 2.2 ARI is absolute, never incremental

`pushAri` sends the state a channel should hold — sellable units, rates and
restrictions per night — not a delta.

This is deliberate and it is what makes at-least-once delivery safe. A retry
after a timeout cannot double-apply anything, and a message that arrives twice
leaves the same result as one that arrives once. Incremental updates make
recovery from a partial failure a reconciliation problem; absolute updates make
it a re-send.

### 2.3 Change detection and delivery

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

### 2.4 Inbound bookings

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
- **The price a guest is quoted is frozen onto the booking.** Later rate changes
  never reach a booking already taken.

## 5. Dates and money

Thailand-first, and specific about it:

- A hotel night is a **calendar date in the property's own timezone**, never a
  UTC timestamp. This is the detail foreign systems most often get wrong, and it
  distorts a whole month of room-night figures when they do.
- Currency is per property, stored in minor units as integers. No floating point
  touches money anywhere in the system.
- VAT and service charge are per-property settings, and whether quoted rates
  include them is explicit rather than assumed.

## 6. Security

| Concern             | Answer                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Channel credentials | **AES-256-GCM** at rest, versioned ciphertext format. Write-only: never returned by the API, the UI or the audit trail |
| Secrets             | Google Secret Manager; never in source, in Terraform state, or in a pull request                                       |
| Database            | Private IP only, no public endpoint, reachable only from inside the VPC                                                |
| Transport           | TLS everywhere; the API is HTTPS-only                                                                                  |
| Authentication      | JWT access tokens with refresh rotation; capability-based authorisation per role                                       |
| Card data           | **None stored.** Payments go through a licensed Thai gateway (Omise); DeeHub never holds a PAN                         |
| Audit               | Every state change records who did it and when, readable in the dashboard                                              |
| Tenant isolation    | Organization scoping on every business table and every query                                                           |

## 7. Reliability and operations

- **Google Cloud Run** in `asia-southeast1`, Cloud SQL for PostgreSQL, Redis for
  the sync queue.
- Automated deploys on merge: lint, typecheck, **718 automated tests**
  (unit, integration against real PostgreSQL, and browser end-to-end) and
  database migrations, all gating the release.
- Error reporting and alerting on API errors, job failures and database
  capacity.
- A scheduled maintenance pass reconciles inventory against reservations and
  reports drift, so a booking-path bug surfaces as an alert rather than as a
  guest arriving at a full hotel.

## 8. Certification readiness

What Agoda would need from us to start: endpoints, message schemas, the
authentication scheme, a sandbox and a test property. What we would deliver:
a connector implementing the interface in §2.1, passing the same contract suite
the reference connector passes, plus Agoda's certification scenarios.

**Estimate: 1–2 weeks from receiving the specification to certification-ready.**
The work is payload translation. Inventory arithmetic, overbooking prevention,
retry, dead-lettering, mapping and inbound handling are built and tested.

## 9. What does not exist yet

Stated because certification finds it anyway:

1. **No production OTA connector.** The framework is proven against the Mock
   OTA. Agoda would be the first real one.
2. **One live property.** The Let's Chill Resort, onboarded this week. DeeHub is
   an early-stage platform and does not claim a portfolio it does not have.
3. **Event-driven sync is not switched on in production yet.** The deployment
   currently runs without the always-on worker, because there is nothing to sync
   to; it is a configuration flag and the infrastructure for it is written and
   in version control. It goes on before any Agoda connection is activated.
4. **A small team.** One engineer-founder. This is a reason to be precise about
   what is built rather than to imply otherwise.

---

## Answers to questions Agoda usually asks

**How often do you push ARI?**
On change, within seconds, via the outbox relay. A full re-push can be forced
at any time, and a nightly reconciliation catches anything the event path
missed.

**How do you handle a failed push?**
Retry with backoff, then dead-letter with the attempt count and the last error.
Because ARI is absolute, a later successful push corrects everything a failed
one would have carried — no repair queue is needed.

**How do you avoid duplicate bookings from redelivered webhooks?**
A unique index on (channel, external reservation id). The second insert fails at
the database.

**What happens if a room type is not mapped?**
The channel cannot be activated. An active channel with a missing mapping does
not fail loudly — it silently skips that room type, the OTA keeps selling
whatever it last heard, and the first symptom is a guest arriving at a full
hotel. Activation is refused until every active room type is mapped, and adding
a new room type flags the channel in the UI.

**Can a property use DeeHub for the front desk while another channel manager
holds the Agoda connection?**
Yes, and that is the current state of our first property. Agoda binds one
connectivity provider per property, so the switch is a scheduled cutover
coordinated with Agoda support rather than a parallel run.

**Support model?**
Founder-led, Thai and English, business hours Asia/Bangkok, with alerting on
the paths that matter (booking creation, channel push failure, database
capacity). We would agree a realistic response commitment rather than claim
24/7 at this stage.
