# Booking.com Connectivity Partner — Technical Submission

Draft answers for the Connectivity Partner Programme application, written to be
copied into whatever form Booking.com sends. Same rule as the Agoda submission
(`agoda-connectivity-application.md`): every claim below is checkable in this
repository, and §10 says plainly what does not exist yet. An application that
oversells gets found out at certification, which is a worse place to be found
out than a form.

Filed in parallel with the Agoda application on purpose — the two queues are
independent, and waiting on one does not shorten the other
(`ota-expansion-plan.md` §4).

> **Before sending, fill in:** legal entity name and registration number,
> registered address, and the pilot property's Booking.com property ID.
> Marked `‹fill in›` below. Do not guess any of them.

> **Known from the property's extranet (2026-08-13):** the pilot property's
> Booking.com connection is **pending with eZee Centrix — powered by Yanolja**,
> and Booking.com states that no new connection can be requested until that one
> is confirmed or cancelled. Whatever this application leads to, the switch is a
> cutover the property has to initiate. The permissions Booking.com asks a
> provider to hold are **rates and availability, reservations, and guest
> reviews** — the third is not something DeeHub does at all (§5).

**Applicant:** DeeHub — hotel platform (PMS + channel manager), Thailand
**Legal entity:** ‹fill in›
**First property to connect:** The Let's Chill Resort Pattaya @ Huayyai,
7 rooms across 2 room types, Booking.com property ID ‹fill in›
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

**We are not a reseller.** DeeHub connects properties that already run their
front desk on DeeHub. That is the honest framing of the portfolio question in
§10: we are not bringing an existing book of properties to Booking.com, we are
building the system those properties run on.

## 2. Connectivity architecture

### 2.1 The connector interface

Every channel implements one port:

| Operation           | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `pushAri`           | Send availability, rates and stay restrictions               |
| `fetchReservations` | Pull bookings                                                |
| `parseWebhook`      | Verify and parse a pushed booking                            |
| `testConnection`    | Prove credentials and reachability without changing anything |

No channel-specific logic exists anywhere in the reservation or inventory
modules — a rule the project has held from its first architecture document.
Booking.com's auth scheme, message shapes and quirks would live entirely behind
this interface.

A reference connector (an in-house "Mock OTA" with its own API and UI) is
already built and passes a contract test suite that every future connector must
also pass. It exists so the framework is proven end to end before a real OTA is
involved, and it stays as a permanent integration harness.

**A fifth operation is planned and not yet built:** an explicit
acknowledgement, for channels that redeliver a reservation until it is
confirmed back. The design is decided
([ADR-0007](adr/0007-connector-port-extension.md)); the code lands with the
first connector that requires it, which may be this one. It is a required
operation on every adapter rather than a special case, so no business module
ever branches on which channel it is talking to.

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

### 2.4 Inbound reservations

Both directions are supported: webhook push and scheduled pull. We will
implement whichever Booking.com's specification prescribes.

- The **raw body is verified before it is parsed**, over the exact bytes
  received. An invalid signature is rejected as unauthenticated and nothing is
  written.
- Every inbound reservation is **stored raw before mapping** and never deleted,
  so a mapping bug is recoverable from the original payload rather than from a
  log.
- Deduplication is a **unique index on (channel, external reservation id)** — a
  database constraint, not application logic, so a redelivery cannot create a
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
- Derived rate plans (a fixed offset from a parent — "non-refundable at 10%
  less") are resolved in a single database view, so the booking path, the ARI
  push and the rate grid cannot disagree about a price.
- Stay restrictions supported: stop-sell, minimum stay, maximum stay, closed to
  arrival, closed to departure.
- **The price a guest is quoted is frozen onto the booking.** Later rate changes
  never reach a booking already taken.
- **Promotions are not built.** A bounded discount — a stay window, a booking
  window, a minimum stay, and a rule for what happens when two of them match —
  is a commercial decision the platform has not taken. Standing offsets are
  covered; campaign pricing is not. If promotion messages are part of
  certification, that is scope we would add, and we would rather say so now.

## 5. Property content

**We do not have a content API, and this is the largest gap in this
application.** DeeHub holds what it needs to sell a room — room types, occupancy,
rate plans, prices, restrictions — and does not hold descriptions, photos,
facilities, policies or address content in a form that could be pushed to a
channel.

Where content management is a required part of the connectivity certification
rather than an optional module, we would build it against the specification.
Our estimate is 2–3 weeks on top of the ARI and reservation work, and it is a
new module rather than a translation of something we already have. Property
content staying manual in the extranet, with DeeHub owning only ARI and
reservations, is the outcome we would prefer for a first integration.

## 6. Dates and money

Thailand-first, and specific about it:

- A hotel night is a **calendar date in the property's own timezone**, never a
  UTC timestamp. This is the detail foreign systems most often get wrong, and it
  distorts a whole month of room-night figures when they do.
- Currency is per property, stored in minor units as integers. No floating point
  touches money anywhere in the system.
- VAT and service charge are per-property settings, and whether quoted rates
  include them is explicit rather than assumed.

## 7. Security

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

**No ISO 27001 and no SOC 2.** Neither is realistic for a company of this size
today, and claiming a roadmap to them would be a sentence written for a form
rather than a plan. The controls above are what exists; they are auditable in
the repository and in the Terraform that builds production.

## 8. Data protection

Stated in more detail than the Agoda submission because Booking.com is an EU
controller and asks:

- **Location.** All guest data is stored in Google Cloud `asia-southeast1`
  (Singapore). No data is replicated outside that region. Backups stay in
  region.
- **Scope.** For a channel reservation we hold what the channel sends: name,
  contact details where provided, stay dates, occupancy, and the amount. No
  payment instrument, no passport or identity document, no special-category
  data.
- **Purpose.** Operating the property's reservation. DeeHub does not sell,
  share or use guest data for marketing, and there is no analytics product
  built on it.
- **Retention and deletion.** Raw inbound payloads are retained for
  recoverability. A deletion request for a named guest can be executed; the
  audit trail retains the fact that a change happened without retaining the
  personal data.
- **Sub-processors:** Google Cloud (hosting, Singapore), Resend (transactional
  email), Omise (payments, Thailand), LINE (staff notifications only, never
  guest data).
- **DPA.** We will sign Booking.com's data processing agreement. We do not have
  our own to propose.

## 9. Reliability and operations

- **Google Cloud Run** in `asia-southeast1`, Cloud SQL for PostgreSQL, Redis for
  the sync queue.
- Automated deploys on merge: lint, typecheck, **718 automated tests** (unit,
  integration against a real PostgreSQL, and HTTP end-to-end) followed by
  **102 browser tests** driving the dashboard in Chromium, and database
  migrations — all gating the release. CI provisions a real Postgres for the
  integration tests rather than mocking one, because the overbooking guard is a
  database constraint and a mocked database proves nothing about it.
- Error reporting and alerting on API errors, job failures and database
  capacity.
- A scheduled maintenance pass reconciles inventory against reservations and
  reports drift, so a booking-path bug surfaces as an alert rather than as a
  guest arriving at a full hotel.
- **Support model:** founder-led, Thai and English, business hours
  Asia/Bangkok, with alerting on the paths that matter (booking creation,
  channel push failure, database capacity). We would agree a realistic response
  commitment rather than claim 24/7 at this stage.

## 10. What does not exist yet

Stated because certification finds it anyway:

1. **No production OTA connector.** The framework is proven against the Mock
   OTA. Agoda and Booking.com are both applications in flight; whichever
   specification arrives first is the first real one.
2. **One live property.** The Let's Chill Resort, onboarded in August 2026.
   DeeHub is an early-stage platform and does not claim a portfolio it does not
   have. If the programme has a minimum property count we do not meet, we would
   rather be told now than discover it at certification.
3. **No content API** (§5).
4. **No promotions engine** (§4).
5. **Reservation acknowledgement is designed, not built** (§2.1).
6. **Event-driven sync is not switched on in production yet.** The deployment
   currently runs without the always-on worker, because there is nothing to
   sync to; it is a configuration flag and the infrastructure for it is written
   and in version control. It goes on before any connection is activated.
7. **No ISO 27001 or SOC 2** (§7).
8. **A small team.** One engineer-founder. This is a reason to be precise about
   what is built rather than to imply otherwise.

## 11. Certification readiness

What we would need to start: endpoints, message schemas, the authentication
scheme, a test environment and a test property, and the certification scenario
pack.

What we would deliver: a connector implementing the interface in §2.1, passing
the same contract suite the reference connector passes, plus Booking.com's
certification scenarios as their own suite.

**Estimate: 2–3 weeks from receiving the specification to certification-ready**
for ARI and reservations, plus 2–3 weeks if content management is required.
The work is payload translation. Inventory arithmetic, overbooking prevention,
retry, dead-lettering, mapping and inbound handling are built and tested.

---

## Answers to questions Booking.com usually asks

**How often do you push ARI?**
On change, within seconds, via the outbox relay. A full re-push can be forced
at any time, and a nightly reconciliation catches anything the event path
missed.

**How do you handle a failed push?**
Retry with backoff, then dead-letter with the attempt count and the last error.
Because ARI is absolute, a later successful push corrects everything a failed
one would have carried — no repair queue is needed.

**How do you avoid duplicate reservations from redelivery?**
A unique index on (channel, external reservation id). The second insert fails at
the database.

**How do you confirm you have received a reservation?**
Not built yet, designed and scheduled — see §2.1. It becomes a required
operation on every connector rather than a Booking.com special case.

**What happens if a room type is not mapped?**
The channel cannot be activated. An active channel with a missing mapping does
not fail loudly — the ARI push silently skips that room type, the OTA keeps
selling whatever it last heard, and the first symptom is a guest arriving at a
full hotel. Activation is refused until every active room type is mapped, and
adding a new room type flags the channel in the UI.

**How many properties will you connect, and how quickly?**
One at launch, and we will not pretend otherwise. Growth depends on DeeHub
winning properties as a PMS, not on migrating an existing portfolio.

**Can a property use DeeHub for the front desk while another provider holds the
Booking.com connection?**
Yes — that is how our first property runs today. Its Booking.com connection sits
with eZee Centrix (Yanolja), as do its Agoda, Expedia and Trip.com connections.
A switch would be a scheduled cutover rather than a parallel run, and we
understand a property can hold only one pending connection request at a time.

**Do you manage guest reviews?**
No. We would ask for rates, availability and reservations only. Review
management is not part of the product and we would rather not hold a permission
we do not use.

**Who do we contact when something breaks?**
The founder, directly. For a one-person team that is a real answer rather than
a support tier that resolves to the same person through a queue.
