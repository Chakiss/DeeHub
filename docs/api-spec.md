# DeeHub Hotel — API Specification

Engineering Task 6. The contract between `apps/api` and every client: the
admin dashboard, the booking engine (Phase 3), and OTA connectors.

The executable source of truth is the OpenAPI document generated from NestJS
decorators at `/api/v1/docs-json`, from which `packages/sdk` is generated
(see [architecture.md §8](architecture.md)). This document defines the rules
that generated spec must follow.

---

## 1. Principles

1. **REST over resources**, with explicit action sub-resources for state
   transitions (`POST /reservations/{id}/cancel`). A reservation's status is
   never set by a client through `PATCH`; the domain owns the state machine
   ([domain-model.md §3.6](domain-model.md)).
2. **Tenancy is in the URL, never in the body.** Property-scoped resources
   are nested under `/properties/{propertyId}`. The organization comes from
   the token and can never be supplied by the client.
3. **Money and dates follow ADR-0003** — money is always an object with
   integer minor units, nights are always `YYYY-MM-DD`.
4. **Every mutating request is safe to retry.** Idempotency keys on creates,
   version checks on updates.
5. **Errors are typed and machine-readable.** The UI must be able to react to
   `INVENTORY_UNAVAILABLE` without parsing prose.
6. **The spec is generated, not hand-maintained.** Drift between docs and
   code is a bug class we design out.

---

## 2. Conventions

| Aspect         | Convention                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Base URL       | `https://api.deehub.io/api/v1`                                                                                                |
| Versioning     | URL path (`/v1`). Breaking changes → `/v2`; additive changes never bump.                                                      |
| Format         | JSON only, `application/json; charset=utf-8`                                                                                  |
| Casing         | `camelCase` in JSON (DB is `snake_case`; mapping happens in the interface layer)                                              |
| IDs            | UUID v7 strings                                                                                                               |
| Instants       | ISO 8601 UTC — `"2026-07-29T09:15:00.000Z"`                                                                                   |
| Nights / dates | `"2026-08-12"` — calendar date in the property's timezone                                                                     |
| Money          | `{ "amount": 250000, "currency": "THB" }` — integer **minor units** (250000 = ฿2,500.00). Never a float, never a bare number. |
| Percentages    | basis points integer (`700` = 7%)                                                                                             |
| Date ranges    | `from` inclusive, `to` **exclusive** — matches nights `[checkIn, checkOut)`                                                   |
| Request ID     | `X-Request-Id` echoed on every response; present in all logs and errors                                                       |

**Single resources are returned bare** (no `{ "data": ... }` wrapper) —
less noise in generated SDK types. **Collections are wrapped** because they
carry pagination.

```jsonc
// GET /properties/{id}/reservations
{
  "items": [{ "id": "...", "code": "DH-8F3K2A" }],
  "pageInfo": { "nextCursor": "eyJpZCI6...", "hasMore": true },
}
```

Cursor pagination for large, time-ordered collections (reservations, audit
logs, sync jobs): stable under concurrent inserts, unlike offsets. Small
configuration collections (room types, rate plans, channels) return in full
with no pagination — a property has tens of these, not thousands.

---

## 3. Authentication

JWT access token (15 min) in `Authorization: Bearer`, refresh token (30 days,
rotating) in an httpOnly cookie for the dashboard.

| Method  | Path                    | Purpose                                                                  |
| ------- | ----------------------- | ------------------------------------------------------------------------ |
| `POST`  | `/auth/login`           | email + password → access token + refresh cookie                         |
| `POST`  | `/auth/refresh`         | rotate refresh token → new access token                                  |
| `POST`  | `/auth/logout`          | revoke the current refresh token                                         |
| `GET`   | `/auth/me`              | current user, memberships, accessible properties                         |
| `POST`  | `/auth/change-password` | change your own password; revokes every other session                    |
| `GET`   | `/users`                | people in the organization and their roles                               |
| `POST`  | `/users`                | create an account; returns a one-time password (no outbound email yet)   |
| `PATCH` | `/users/{id}`           | change name, role or status; `DISABLED` replaces deletion                |
| `POST`  | `/auth/forgot-password` | email a reset link; always 202, never reveals whether the account exists |
| `POST`  | `/auth/reset-password`  | consume a reset link and set a new password                              |

Everything above is implemented.

There are two recovery paths and they are for different situations.
**Self-service** (`forgot-password` → `reset-password`) is the normal one: a
link is emailed, works once, and expires in an hour. **Operator-driven**
(`POST /users/{id}/reset-password`) covers the case self-service cannot — a
mailbox the person can no longer reach.

Four properties of the self-service path are load-bearing:

- **It never says whether an account exists.** Unknown address, disabled
  account, suspended organization and a real account all produce the same 202
  with the same body. The endpoint also spends a fixed minimum of time on every
  request, because otherwise the work it does for a real account is a timing
  oracle for the answer the body withholds.
- **The link is emailed directly, not through the notification log.** Every
  other message is stored with its rendered body and shown on the delivery-log
  screen to anyone holding `notification:read` — a reset link there would let a
  front-desk clerk take the owner's account. This one send bypasses the log.
  The audit trail records that a reset was requested, never the token or its
  hash.
- **Completing a reset issues no session.** The person signs in with the
  password they just chose. A link sitting in a mailbox must not be a session.
- **It closes every other door.** A completed reset revokes all refresh tokens
  and invalidates any other reset link in flight; a password CHANGE invalidates
  live links too, so securing an account cannot be undone an hour later by a
  link somebody else requested.

At most three live links may exist per account per fifteen minutes. That is
mailbox protection rather than brute-force protection — the token is 256 bits —
and being over the limit is silent, because saying so would confirm the account
exists.

```jsonc
// POST /auth/forgot-password → 202 (always, whatever happened)
// { "organizationSlug": "deehub-demo", "email": "owner@deehub.io", "locale": "th" }
{ "accepted": true }

// POST /auth/reset-password → 200
// { "token": "<from the emailed link>", "newPassword": "at least 12 characters" }
{ "organizationSlug": "deehub-demo", "email": "owner@deehub.io" }

// POST /auth/reset-password → 401, for unknown, expired and already-used alike
{ "error": { "code": "UNAUTHENTICATED", "message": "This reset link is no longer valid. Request a new one." } }
```

`locale` is supplied by the client because nobody is authenticated: there is no
property whose country could stand in for a language, but the person is looking
at a sign-in screen they have just chosen Thai or English on.

Resetting your own password is refused. `POST /auth/change-password` is the path
for that, and it demands the current password — without that asymmetry a stolen
access token would be enough to lock the real owner out of their own hotel.

```jsonc
// POST /auth/login → 200
{
  "accessToken": "eyJhbGciOi...",
  "expiresIn": 900,
  "user": {
    "id": "01920f...",
    "email": "owner@deehub.io",
    "fullName": "Somchai P.",
    "organization": { "id": "0191ff...", "name": "DeeHub Demo", "slug": "deehub-demo" },
    "memberships": [
      { "role": "OWNER", "propertyId": null },
      { "role": "FRONT_DESK", "propertyId": "01920a..." },
    ],
  },
}
```

Access-token claims: `sub`, `orgId`, `jti`, `exp`. **Roles and permissions
are not in the token** — they are loaded per request, so revoking access
takes effect immediately rather than after token expiry.

---

### Rooms and the stay view (Phase 4)

| Method  | Path                                   | Purpose                                               |
| ------- | -------------------------------------- | ----------------------------------------------------- |
| `GET`   | `/properties/{id}/rooms`               | physical rooms, by floor then number                  |
| `POST`  | `/properties/{id}/rooms`               | add a room                                            |
| `PATCH` | `/properties/{id}/rooms/{roomId}`      | rename, take out of service, set housekeeping status  |
| `PATCH` | `/properties/{id}/stays/{stayId}/room` | assign a booking to a room, or release it with `null` |
| `GET`   | `/properties/{id}/stay-view`           | who is in which room, plus what still needs one       |

Physical rooms never influence availability (ADR-0002). Assigning every room in
the hotel changes no number an OTA sees; allotment is what the property chose to
sell, which is what makes controlled overselling a decision rather than an
accident of how many keys exist.

Check-in refuses unless EVERY stay on the booking has a room — checking in a
three-room party with two rooms assigned leaves a guest in reception with
nowhere to sleep — and refuses a booking that arrives later, which is someone
clicking the wrong row. Early arrival on the arrival day is allowed. Status
lives on the reservation, so a multi-room booking arrives as one party.

Check-out marks the rooms DIRTY, which is the point of modelling it at all, and
leaves a room somebody took OUT_OF_ORDER alone. It does NOT release inventory —
the guest occupied those nights, and giving them back would make historical
occupancy lie — and it does NOT clear the room assignment, because "who was in
302 last Tuesday" is a question hotels ask.

Two bookings cannot hold the same room on overlapping nights, and that is
enforced by an `EXCLUDE` constraint rather than a read-then-write — so it holds
when two people assign at once. Nights are half-open, so a departure and an
arrival on the same day are not a conflict. Cancelling a reservation releases
any room it held; the constraint cannot see reservation status, so without that
the room would stay blocked for those nights forever.

### Guests (Phase 4)

| Method  | Path                                           | Purpose                                 |
| ------- | ---------------------------------------------- | --------------------------------------- |
| `GET`   | `/properties/{id}/guests`                      | search by name, email or phone          |
| `GET`   | `/properties/{id}/guests/{guestId}`            | one profile with stay count and revenue |
| `PATCH` | `/properties/{id}/guests/{guestId}`            | correct a profile                       |
| `GET`   | `/properties/{id}/guests/{guestId}/duplicates` | profiles that might be the same person  |
| `POST`  | `/properties/{id}/guests/{guestId}/merge`      | fold another profile into this one      |

A profile is created from the booker the first time someone books, and a
returning guest is matched on email **and** last name — never on email alone.
Shared addresses are real: a company books its staff through one inbox, and
matching on the address would show one person another's stay history with
nothing in the data revealing it. A duplicate profile is the safer failure
because it is visible and can be merged; a wrong merge is neither.

**Finding duplicates** is broader than that matching rule, because it only
decides what to show somebody. Three signals, each reported so an operator can
see the reasoning rather than a score:

| Signal  | Matches on                      | Alone                                         |
| ------- | ------------------------------- | --------------------------------------------- |
| `PHONE` | the last nine digits            | `HIGH` — people share an inbox, not a handset |
| `EMAIL` | the address, case-insensitively | `MEDIUM` — `info@` books a whole company      |
| `NAME`  | first **and** last, lowercased  | `LOW` — surnames repeat constantly            |

`EMAIL` and `NAME` together are `HIGH`. Nine trailing digits makes
`081 234 5678` and `+66 81 234 5678` the same number without needing a country
code the system does not reliably have.

**Merging** names the survivor in the path and the duplicate in the body. The
direction is never inferred — it decides whose spelling, address and notes lead,
and the operator looking at both records is the one who knows. In one
transaction: every reservation moves to the survivor, the survivor fills its own
blanks from the duplicate and never overwrites a value it already had, notes are
joined rather than chosen, and the duplicate becomes a tombstone pointing at the
survivor.

```jsonc
// POST /properties/{id}/guests/{survivorId}/merge → 201
// { "duplicateId": "0192..." }
{
  "guest": { "id": "0191...", "stays": 4, "email": "somchai@example.com", "phone": "0812345678" },
  "reservationsMoved": 2,
  "fieldsFilled": ["phone", "notes"],
}
```

A tombstone is not a guest: it is absent from search, from `GET` by id, from the
candidate list, and from the booking path's matching. It is kept rather than
deleted because a merge cannot be read back out of the surviving rows, and an id
that still resolves is what makes "who was this?" answerable. There is **no
unmerge** — the audit entry names every reservation that moved, so one could be
built, but it is a second dangerous operation and the merge already requires two
profiles in front of a person.

Both sides are audited: `guest.merged` against the survivor, `guest.merged_away`
against the duplicate, because an investigator arrives holding one id and not
the other. Neither entry carries the encrypted document number — the audit table
is not encrypted, and copying it there would defeat the column that is.

The profile is organization-wide — the same person across a group is the point
of keeping one — but the LIST is scoped to guests who have booked at that
property, which is what a front desk means by "our guests" and what makes the
screen reachable with property-level permission. Stay counts stay
organization-wide.

### Folio (Phase 4)

| Method | Path                                                            | Capability   |
| ------ | --------------------------------------------------------------- | ------------ |
| `GET`  | `/properties/{pid}/reservations/{id}/folio`                     | `folio:read` |
| `POST` | `/properties/{pid}/reservations/{id}/folio/charges`             | `folio:post` |
| `POST` | `/properties/{pid}/reservations/{id}/folio/payments`            | `folio:post` |
| `POST` | `/properties/{pid}/reservations/{id}/folio/charges/{lid}/void`  | `folio:void` |
| `POST` | `/properties/{pid}/reservations/{id}/folio/payments/{lid}/void` | `folio:void` |

One booking, one account. There is no `folios` table and no folio id — a folio
row would carry a reservation id and nothing else. Splitting a bill between a
company and a guest is real, needs one, and is not built.

**Room charges are derived, not stored.** They come from the reservation's
frozen night prices, which already move correctly when a stay is extended,
shortened or cancelled. Copying them into a ledger would create two numbers that
must agree and a reconciliation bug the first time one of those operations
forgot the copy. The trade: a true posted-charge ledger is what a night audit
needs to freeze a day's revenue, and this cannot do that yet.

**Extras compose with the room, not alongside it.** A taxable extra joins the
room subtotal before service charge and VAT are applied, because two separate
roundings put the total a baht or two away from the sum of the printed lines. A
line marked `taxable: false` — a damage recovery, a pass-through — is added
after the tax instead; VAT on it would overcharge the guest and misstate output
tax.

**Payments and refunds are separate rows with positive amounts.** A refund as a
negative payment is shorter and is why cash reports come out wrong: "taken
today" becomes a net figure that hides both sides, and a cashier counting a
drawer needs them apart. Each row records the trading day in the property's
timezone and who keyed it, which is what a cashier reconciliation is built on.

Overpaying is allowed and shows a negative balance — the hotel owes the guest.
Refunding more than was ever taken is refused with `422`: that is not rounding,
it is a cashier typing into the wrong booking.

**Nothing is deleted; lines are voided** with a reason, which is required. "This
was charged and reversed" is a different fact from "this was never charged", and
it is the one somebody wants when a till does not balance. Voiding is behind
`folio:void`, which FRONT_DESK does not hold — taking money is the job,
un-taking it belongs to whoever is accountable for the till.

Charges are refused on a `CANCELLED` booking and ALLOWED on a `CHECKED_OUT` one:
the minibar is checked after the guest leaves, and refusing would send the desk
to a spreadsheet.

`POST /reservations/{id}/check-out` now returns `outstandingBalance`. It is
reported, never enforced — plenty of departures are legitimately unsettled (an
OTA has collected, a company is billed monthly), and blocking one would stop a
guest leaving over a bill nobody meant to collect at the desk.

### Reporting (Phase 4)

| Method | Path                                   | Purpose                                             |
| ------ | -------------------------------------- | --------------------------------------------------- |
| `GET`  | `/properties/{id}/reports/performance` | rooms sold, revenue, ADR, RevPAR, occupancy         |
| `GET`  | `/properties/{id}/reports/pickup`      | business taken for each stay date since a past date |

Two denominators are reported, deliberately. `occupancy` and `revPar` use
PHYSICAL rooms — the industry definitions, and the figures an owner compares
against an STR report or a previous PMS — and are **null** until rooms exist,
because a property can operate on allotment alone and reporting 0% would be a
lie. `sellThrough` uses allotment and answers "how much of what I offered did I
sell", which is always computable. `adr` needs no denominator choice.

**Pickup** answers the forward-looking question: how much business arrived for
the nights ahead since a past business date. `from`/`to` bound the STAY dates;
`asOf` names the baseline and defaults to a week ago.

It is the one report that cannot be derived from live rows, because live rows do
not remember when they arrived. `reservations.created_at` almost works and is
wrong in exactly the cases a revenue manager is looking at: a booking made on
Monday and cancelled on Wednesday was genuinely on the books on Tuesday, and a
stay whose dates moved was never on the books for the dates it now holds. So the
maintenance job freezes on-the-books figures once per property per business date
into `otb_snapshots`, and pickup is the difference between then and now.

"Now" is read LIVE, not from today's snapshot — it has to equal the number the
performance report shows on the same screen, and a figure ten minutes stale next
to a booking the clerk just took would cost trust in both.

Three properties of the response matter:

- `asOfUsed` is the snapshot actually found (the newest at or before `asOf`),
  and may differ from `asOfRequested`. If the job missed three days, "pickup
  over the last week" silently spans ten; the field is how a caller notices.
- Every pickup figure is **null** when no snapshot exists at all, never zero.
  Comparing against nothing would report every existing booking as new business.
- Pickup goes **negative** when more was cancelled than booked. That is a
  reading, not an error.

History starts when the first snapshot is taken and cannot be backfilled;
`earliestSnapshot` says when that was.

```jsonc
// GET /properties/{id}/reports/pickup?from=2026-08-01&to=2026-10-01&asOf=2026-07-25
{
  "asOfRequested": "2026-07-25",
  "asOfUsed": "2026-07-25",
  "earliestSnapshot": "2026-07-02",
  "currency": "THB",
  "nights": [
    {
      "date": "2026-08-01",
      "roomsSold": 9,
      "baselineRoomsSold": 6,
      "pickupRooms": 3,
      "pickupRevenueMinor": 750000,
    },
  ],
  "totals": { "roomsSold": 9, "pickupRooms": 3, "pickupRevenueMinor": 750000 },
}
```

Rooms sold counts the same statuses the inventory grid counts as booked. A
report that disagreed with the grid on the same refresh would make an operator
distrust both.

One approximation: the room count is today's, applied to past dates. No history
of room additions is kept.

## 4. Errors

Every non-2xx response uses one envelope:

```jsonc
{
  "error": {
    "code": "INVENTORY_UNAVAILABLE",
    "message": "No availability for Deluxe Double on 2026-08-12.",
    "details": { "roomTypeId": "0192...", "unavailableDates": ["2026-08-12"] },
    "requestId": "req_01J2X...",
  },
}
```

| Code                       | HTTP | Meaning                                                  |
| -------------------------- | ---- | -------------------------------------------------------- |
| `VALIDATION_ERROR`         | 422  | Malformed input; `details.fields[]` lists field + reason |
| `UNAUTHENTICATED`          | 401  | Missing/expired/invalid token                            |
| `FORBIDDEN`                | 403  | Authenticated but lacks the capability                   |
| `NOT_FOUND`                | 404  | Resource does not exist **or belongs to another tenant** |
| `CONFLICT`                 | 409  | Uniqueness violation (duplicate code)                    |
| `VERSION_MISMATCH`         | 409  | Optimistic lock failed; refetch and retry                |
| `INVENTORY_UNAVAILABLE`    | 409  | Not enough allotment for one or more nights              |
| `RESTRICTION_VIOLATED`     | 422  | Stop-sell, min/max stay, CTA or CTD blocks the stay      |
| `RATE_MISSING`             | 422  | A night in the stay has no price for that occupancy      |
| `INVALID_STATE_TRANSITION` | 409  | e.g. checking in a cancelled reservation                 |
| `ALLOTMENT_BELOW_BOOKED`   | 409  | Allotment cannot drop below units already sold           |
| `MAPPING_MISSING`          | 422  | Channel operation without a room-type/rate-plan mapping  |
| `IDEMPOTENCY_KEY_REUSED`   | 409  | Same key, different payload                              |
| `RATE_LIMITED`             | 429  | Includes `Retry-After`                                   |
| `INTERNAL_ERROR`           | 500  | Unexpected; `requestId` correlates to Sentry             |

**Cross-tenant access returns 404, not 403.** A 403 would confirm that a
resource exists in another organization — an existence oracle. Every
tenant-scoped miss is indistinguishable from a genuine miss.

`RESTRICTION_VIOLATED` names the specific restriction so the dashboard can
say "minimum stay is 3 nights" rather than "booking failed":

```jsonc
{
  "error": {
    "code": "RESTRICTION_VIOLATED",
    "message": "Minimum stay is 3 nights.",
    "details": { "restriction": "MIN_STAY", "date": "2026-12-31", "required": 3, "requested": 1 },
  },
}
```

---

## 5. Idempotency and concurrency

**Creates.** `POST /reservations` and every OTA-facing mutation require an
`Idempotency-Key` header (client-generated UUID). The key is stored with a
hash of the request body for 24 hours:

- Same key, same body → the original response is replayed, no second booking.
- Same key, different body → `409 IDEMPOTENCY_KEY_REUSED`.
- Retries after a network timeout are therefore always safe. Without this, a
  timeout on a booking request is indistinguishable from a failure, and the
  retry double-books a room.

**Updates.** Mutations on reservations carry the `version` they were read at:

```jsonc
PATCH /properties/{pid}/reservations/{id}
{ "version": 3, "specialRequests": "Late arrival, 23:00" }
```

Stale version → `409 VERSION_MISMATCH`. This is what stops two front-desk
staff silently overwriting each other.

---

## 6. Endpoints

Capabilities in the right column are the permission checked
([architecture.md §10](architecture.md)).

### 6.1 Organization & users

| Method  | Path                      | Capability          |
| ------- | ------------------------- | ------------------- |
| `GET`   | `/organizations/current`  | `org:read`          |
| `PATCH` | `/organizations/current`  | `org:update`        |
| `GET`   | `/users`                  | `user:read`         |
| `POST`  | `/users/invite`           | `user:invite`       |
| `PATCH` | `/users/{id}`             | `user:update`       |
| `POST`  | `/users/{id}/disable`     | `user:update`       |
| `PUT`   | `/users/{id}/memberships` | `user:manage-roles` |

### 6.2 Properties and setup

| Method                 | Path                                | Capability                          |
| ---------------------- | ----------------------------------- | ----------------------------------- |
| `GET` `POST`           | `/properties`                       | `property:read` / `property:create` |
| `GET` `PATCH`          | `/properties/{pid}`                 | `property:read` / `property:update` |
| `GET` `POST`           | `/properties/{pid}/room-types`      | `roomtype:read` / `roomtype:create` |
| `GET` `PATCH` `DELETE` | `/properties/{pid}/room-types/{id}` | `roomtype:*` (DELETE deactivates)   |
| `GET` `POST`           | `/properties/{pid}/rooms`           | `room:read` / `room:create`         |
| `PATCH`                | `/properties/{pid}/rooms/{id}`      | `room:update`                       |
| `GET` `POST`           | `/properties/{pid}/rate-plans`      | `rateplan:read` / `rateplan:create` |
| `GET` `PATCH` `DELETE` | `/properties/{pid}/rate-plans/{id}` | `rateplan:*`                        |

Property `timezone` and `currency` become immutable once a reservation
exists; attempting to change them returns `409 CONFLICT`.

#### Derived rate plans

A plan may be priced as an OFFSET from another instead of holding prices of its
own — "non-refundable at 10% less", "breakfast included at 300 more". One edit
then reprices the whole horizon, which is the point: maintaining four plans by
hand across 400 nights is how prices drift apart.

```jsonc
// POST /properties/{pid}/rate-plans
{
  "roomTypeId": "0191…",
  "code": "NRF",
  "name": "Non-refundable",
  // Signed. Basis points for PERCENTAGE, minor units for AMOUNT.
  "derivation": { "parentRatePlanId": "0192…", "type": "PERCENTAGE", "value": -1000 },
}
```

Resolution happens in ONE place — the `effective_rate_days` view — because three
readers need it (the booking path, the ARI push, the grid's lead rate) and three
implementations is three chances to quote a different number than the guest was
shown.

Four rules, all refused with `422` at creation rather than discovered later:

- **Same room type as the parent.** Otherwise a room is priced from a different
  room's price, and the lead-rate query, which groups by the plan's own room
  type, stops making sense.
- **One level, no chains.** A derived plan reads its parent's STORED rows; a
  parent that is itself derived has none, so the child would resolve to no price
  at all rather than to a compounded discount.
- **The parent must still be selling.** An inactive parent is excluded from the
  lead rate and from ARI, so a child of one would look configured and reach
  nobody.
- **Not −100%, and not zero.** At −100% every night computes to zero and the
  room is given away; at zero the plan duplicates its parent, which is a mapping
  mistake at every OTA it reaches.

A computed price of zero or less is **absent, not free**: the view omits it, and
every caller already treats a night with no price as unsellable. That is the
safe reading of an offset somebody typed wrong.

`PATCH` can change the offset VALUE and nothing else about the derivation.
Switching a plan between derived and not would strand its stored prices or leave
it with none — a migration of rows, not a patch to one. Prices cannot be written
to or cleared from a derived plan at all; `PATCH`/`DELETE /rates` answer `422`
naming the parent, because rows written there would land in `rate_days` where
the view never looks for a derived plan.

**Promotions are not built.** A derived plan covers the standing case — a rate
that is always a fixed offset — and not the bounded one: a discount that applies
to stays in March, booked before January, for three nights or more. That needs
stay-window, booking-window and length-of-stay conditions plus a rule for what
happens when two of them match, and the last part is a commercial decision
rather than a technical one.

### 6.3 Inventory

The calendar grid is the dashboard's main screen, so reads are shaped for it
directly rather than making the client stitch rows together.

```
GET /properties/{pid}/inventory?from=2026-08-01&to=2026-09-01&roomTypeIds=a,b
```

```jsonc
{
  "from": "2026-08-01",
  "to": "2026-09-01",
  "roomTypes": [
    {
      "roomTypeId": "0192a...",
      "code": "DLX",
      "name": "Deluxe Double",
      "days": [
        {
          "date": "2026-08-01",
          "allotment": 10,
          "booked": 7,
          "available": 3,
          "stopSell": false,
          "minStay": 1,
          "maxStay": null,
          "closedToArrival": false,
          "closedToDeparture": false,
        },
      ],
    },
  ],
}
```

Writes are **bulk range operations**, because no hotelier edits 90 checkboxes
one at a time. One request sets a rule across a date range, optionally
filtered by weekday:

```jsonc
PATCH /properties/{pid}/inventory
{
  "updates": [
    { "roomTypeId": "0192a...", "from": "2026-12-24", "to": "2027-01-03",
      "daysOfWeek": ["FRI","SAT"],          // optional; omit = every day
      "allotment": 8, "minStay": 3, "stopSell": false }
  ]
}
```

Response reports what changed and refuses partial nonsense atomically — the
whole request is one transaction. Lowering allotment below `booked` returns
`409 ALLOTMENT_BELOW_BOOKED` with the offending dates in `details`.

| Method  | Path                                     | Capability                                     |
| ------- | ---------------------------------------- | ---------------------------------------------- |
| `GET`   | `/properties/{pid}/inventory`            | `inventory:read`                               |
| `PATCH` | `/properties/{pid}/inventory`            | `inventory:update`                             |
| `POST`  | `/properties/{pid}/inventory/open-dates` | `inventory:update` — creates rows to a horizon |

### 6.4 Rates

Same grid-and-bulk shape as inventory.

| Method  | Path                                             | Capability    |
| ------- | ------------------------------------------------ | ------------- |
| `GET`   | `/properties/{pid}/rates?from=&to=&ratePlanIds=` | `rate:read`   |
| `PATCH` | `/properties/{pid}/rates`                        | `rate:update` |

```jsonc
PATCH /properties/{pid}/rates
{
  "updates": [
    { "ratePlanId": "0192b...", "from": "2026-12-24", "to": "2027-01-03",
      "prices": [ { "occupancy": 2, "amount": { "amount": 450000, "currency": "THB" } } ] }
  ]
}
```

### 6.5 Availability

```
GET /properties/{pid}/availability?checkIn=2026-08-12&checkOut=2026-08-15&adults=2&children=0
```

```jsonc
{
  "checkIn": "2026-08-12",
  "checkOut": "2026-08-15",
  "nights": 3,
  "roomTypes": [
    {
      "roomTypeId": "0192a...",
      "name": "Deluxe Double",
      "availableUnits": 3,
      "ratePlans": [
        {
          "ratePlanId": "0192b...",
          "name": "BAR Room Only",
          "total": { "amount": 750000, "currency": "THB" },
          "perNight": [{ "date": "2026-08-12", "amount": { "amount": 250000, "currency": "THB" } }],
          "bookable": true,
        },
      ],
    },
  ],
  "unavailable": [
    {
      "roomTypeId": "0192c...",
      "reason": "RESTRICTION_VIOLATED",
      "detail": { "restriction": "CLOSED_TO_ARRIVAL", "date": "2026-08-12" },
    },
  ],
}
```

Unbookable room types are returned **with a reason** rather than omitted, so
staff can see _why_ the system won't sell a room and fix the restriction.

### 6.6 Reservations

| Method  | Path                                                      | Capability                                         |
| ------- | --------------------------------------------------------- | -------------------------------------------------- |
| `GET`   | `/properties/{pid}/reservations`                          | `reservation:read`                                 |
| `POST`  | `/properties/{pid}/reservations`                          | `reservation:create`                               |
| `GET`   | `/properties/{pid}/reservations/{id}`                     | `reservation:read`                                 |
| `PATCH` | `/properties/{pid}/reservations/{id}`                     | `reservation:update` — contact/notes only          |
| `PATCH` | `/properties/{pid}/reservations/{id}/stays/{sid}`         | `reservation:modify` — dates, room type, occupancy |
| `POST`  | `/properties/{pid}/reservations/{id}/stays/{sid}/extend`  | `reservation:modify` — add nights at the end       |
| `POST`  | `/properties/{pid}/reservations/{id}/stays/{sid}/shorten` | `reservation:modify` — drop nights from the end    |
| `POST`  | `/properties/{pid}/reservations/{id}/confirm`             | `reservation:update`                               |
| `POST`  | `/properties/{pid}/reservations/{id}/cancel`              | `reservation:cancel`                               |
| `POST`  | `/properties/{pid}/reservations/{id}/check-in`            | `reservation:checkin`                              |
| `POST`  | `/properties/{pid}/reservations/{id}/check-out`           | `reservation:checkout`                             |
| `POST`  | `/properties/{pid}/reservations/{id}/no-show`             | `reservation:update`                               |
| `GET`   | `/properties/{pid}/reservations/{id}/audit`               | `audit:read`                                       |

**Modification** is `PATCH` on ONE STAY, not `POST .../modify-stay` as this
document originally planned. A reservation can hold twenty rooms and the
operation changes exactly one of them, so the stay has to be named in the path;
`/modify-stay` could not say which. `PATCH` because absent fields keep their
current value.

`version` is required and is the RESERVATION's version, not the stay's — the
whole booking is re-priced, so a concurrent edit to a sibling stay must conflict.

The old nights are released BEFORE the new ones are held, in one transaction.
Moving 3rd–5th to 4th–6th overlaps the booking's own nights; holding first
would make it compete with itself and fail on a night it already occupies.

Refused with `422` when any night of the stay is already in the past. Releasing
a night a guest slept in would retroactively claim the room was free
(domain-model.md §3.5). That case is `/extend` below.

The response carries `roomAssignmentCleared`. Changing dates or room type drops
any assigned room, because the room may now be occupied by someone else on the
new nights and the exclusion constraint would reject the write with an
unreadable database error.

**Extension** is a separate operation, `POST .../stays/{sid}/extend`, taking
only `version`, `checkOut` and an optional `reason`. It is not a flag on the
PATCH because the two have opposite relationships with inventory: modifying
RELEASES the stay's nights before taking new ones, extending only ever TAKES.
That is precisely why it works on a booking the guest has already started —
`PENDING`, `CONFIRMED` and `CHECKED_IN` are all extendable — and why the nights
already held are never re-evaluated, re-priced or given back.

The added nights are `[old check-out, new check-out)`. They are quoted from the
stay's existing rate plan at TODAY's prices; the nights already booked keep the
prices the guest was quoted. `422` if the plan has no price for an added night.

Arrival restrictions are deliberately NOT re-evaluated. Closed-to-arrival,
minimum stay and maximum stay belong to the night the guest arrived, which an
extension does not touch — enforcing them here would refuse a real front-desk
request because the first added night is closed to arrival, when nobody is
arriving. Stop-sell, availability and closed-to-departure on the new date all
still apply.

The assigned room is KEPT, not cleared. If another booking holds that room on
one of the added nights the whole operation is refused with `409` naming the
room and the booking in the way, because a guest who is physically in 302
tonight cannot be quietly un-assigned — someone has to be moved, and that is the
desk's decision.

**Early departure** is `POST .../stays/{sid}/shorten`, the mirror of `/extend`
and the same body. Separate from the PATCH for the same reason: it releases only
the TAIL of the stay, never the nights already slept, so it works on a booking
in progress. The released nights are `[new check-out, old check-out)`.

`422` when the new date is not earlier than the current one, when it is before
the property's business date — releasing a night the guest slept through would
claim the room was free — or when it would leave the stay with no nights at all.
That last case is a cancellation: it releases the room, tells the guest and
moves the booking to `CANCELLED`, none of which a zero-night reservation would
do. The refusal says so.

The assigned room is KEPT and nothing can refuse the write: the stay's date
range only narrows, so the room-overlap constraint has nothing to object to. The
guest is in that room until they walk out of it.

**No early-departure fee is charged.** The dropped nights come off the bill at
the price they were quoted — `refundedAmount` in the response — and nothing is
added back. Most hotels do charge one, and the missing piece is not somewhere to
put it: the guest's folio exists and the desk can post a charge against it. The
missing piece is the POLICY. Nothing on a rate plan says what leaving early
costs, so a number invented here would be applied silently to every booking,
including the flexible ones a hotel deliberately sells as free to cancel. The
audit entry records `earlyDepartureFeeMinor: 0`, so a fee posted afterwards is
visibly a separate human decision.

List filters: `status`, `checkInFrom/To`, `checkOutFrom/To`, `channelId`,
`q` (code, guest name, email, phone), `createdFrom/To`, plus `cursor`/`limit`.

```jsonc
// POST /properties/{pid}/reservations   Idempotency-Key: 0192...
{
  "source": "WALK_IN",
  "booker": { "name": "Somchai Prasert", "email": "s@example.com", "phone": "+66811234567" },
  "stays": [
    {
      "roomTypeId": "0192a...",
      "ratePlanId": "0192b...",
      "checkIn": "2026-08-12",
      "checkOut": "2026-08-15",
      "adults": 2,
      "children": 0,
      "guestName": "Somchai Prasert",
    },
  ],
  "specialRequests": "High floor",
  "status": "CONFIRMED", // or PENDING to hold; default CONFIRMED
}
```

```jsonc
// → 201 Created
{
  "id": "0192d...",
  "code": "DH-8F3K2A",
  "status": "CONFIRMED",
  "version": 0,
  "propertyId": "0192...",
  "source": "WALK_IN",
  "booker": { "name": "Somchai Prasert", "email": "s@example.com", "phone": "+66811234567" },
  "stays": [
    {
      "id": "0192e...",
      "roomTypeId": "0192a...",
      "roomTypeName": "Deluxe Double",
      "ratePlanId": "0192b...",
      "checkIn": "2026-08-12",
      "checkOut": "2026-08-15",
      "adults": 2,
      "children": 0,
      "assignedRoomId": null,
      "subtotal": { "amount": 750000, "currency": "THB" },
      "nights": [{ "date": "2026-08-12", "amount": { "amount": 250000, "currency": "THB" } }],
    },
  ],
  "subtotal": { "amount": 750000, "currency": "THB" },
  "serviceCharge": { "amount": 75000, "currency": "THB" },
  "tax": { "amount": 57750, "currency": "THB" },
  "total": { "amount": 882750, "currency": "THB" },
  "createdAt": "2026-07-29T09:15:00.000Z",
}
```

Two stays for two rooms of the same type — one stay is one room unit
([database.md §1](database.md)). The whole request is one transaction: if
night three of stay two is full, nothing is written and the response is
`409 INVENTORY_UNAVAILABLE` listing the exact dates.

`modify-stay` releases the old nights and holds the new ones in a single
transaction; it never deletes and recreates the reservation, so the code,
audit trail and channel references survive. If the new dates are unavailable
the original booking is left untouched.

### 6.7 Guests

| Method        | Path                        | Capability                    |
| ------------- | --------------------------- | ----------------------------- |
| `GET`         | `/guests?q=&cursor=`        | `guest:read`                  |
| `GET` `PATCH` | `/guests/{id}`              | `guest:read` / `guest:update` |
| `GET`         | `/guests/{id}/reservations` | `guest:read`                  |

Organization-scoped, not property-scoped — a returning guest is shared across
an owner's properties.

### 6.8 Channels and sync

| Method        | Path                                              | Capability                        |
| ------------- | ------------------------------------------------- | --------------------------------- |
| `GET` `POST`  | `/properties/{pid}/channels`                      | `channel:read` / `channel:create` |
| `GET` `PATCH` | `/properties/{pid}/channels/{id}`                 | `channel:read` / `channel:update` |
| `PUT`         | `/properties/{pid}/channels/{id}/mappings`        | `channel:update`                  |
| `POST`        | `/properties/{pid}/channels/{id}/test-connection` | `channel:sync`                    |
| `POST`        | `/properties/{pid}/channels/{id}/sync`            | `channel:sync`                    |

Credentials are write-only: accepted on `POST`/`PATCH`, never returned. Reads
show `"hasCredentials": true` and nothing more. They are absent from the audit
trail too, which records only `credentialsProvided`.

**A channel is created INACTIVE and cannot be activated until every active room
type is mapped.** This is the rule that prevents the silent failure: an active
channel with a missing mapping does not error, the ARI push simply skips that
room type, so the OTA keeps selling availability nobody is updating and the
first symptom is an overbooking. The `409` names the unmapped room types.

`PUT /mappings` replaces the whole set rather than patching it. Mappings are a
set, and the unique indexes on `(channel, local)` and `(channel, external)` mean
an incremental edit can collide with a row the same request is about to delete.

`GET /channels/{id}` folds in what the planned `/sync-jobs`, `/health` and
`/mappings` reads would each have returned — mappings both ways, the twenty most
recent sync jobs, and the inbound bookings received. One screen, one request.
The list endpoint carries the health summary (`status`, `lastSyncAt`,
`lastError`, mapped-versus-total room types) so the strip needs no extra call.

**`POST /test-connection`** asks the channel whether the credentials work.
`testConnection` had been on the connector port since the framework was written
and nothing ever called it, so a wrong credential could only be discovered by
activating the channel and waiting for a booking that never came.

A refusal from the OTA answers with `200` and `{ "ok": false, "detail": … }`.
The request succeeded and the answer was no; an HTTP error would render a
configuration problem as a network one and send somebody to look at the wrong
thing. The outcome is written to `lastError` so it survives a reload, and
deliberately does NOT change `status` — an inactive channel that fails a test is
switched off, not broken, and moving it to `ERROR` would also collide with the
partial unique index permitting one non-inactive channel per type per property.
Status belongs to the operator and to the sync engine.

Both endpoints require `channel:sync` rather than `channel:read`. Testing looks
like a read and is not: it opens an authenticated connection to a third party
using the hotel's credentials, and rate limits at the other end are real.

**`POST /sync`** pushes the whole horizon for every mapped room type, now. The
sync engine is event-driven, which is right for the steady state and cannot help
in the three cases an operator hits: the channel was inactive while prices
changed, a mapping was fixed after a failed push, or nobody trusts what the OTA
is currently showing.

It runs INLINE rather than enqueuing. The operator clicked a button and should
see the result, not a job id — and enqueuing needs Redis, which a deployment
with `enable_channel_sync` off does not have. **A forced sync is therefore the
only way such a deployment can push at all**, which is a capability rather than
a workaround.

Refused with `409` for a channel that is not `ACTIVE` (pushing would make an OTA
start selling rooms the hotel deliberately took off it) or one with no room type
mapped. One room type failing does NOT abandon the rest: each is reported
separately, because a missing rate mapping on one room type is a local problem
and giving up would leave the channel worse than before the button was pressed.

```jsonc
// POST /properties/{pid}/channels/{id}/sync → 200
{
  "from": "2026-08-01",
  "to": "2027-08-01",
  "nights": 365,
  "roomTypes": [
    { "roomTypeId": "0191…", "accepted": 365, "rejected": 0, "warnings": [], "error": null },
    {
      "roomTypeId": "0192…",
      "accepted": 0,
      "rejected": 0,
      "warnings": [],
      "error": "No rate plan mapped for this room type",
    },
  ],
}
```

**No real OTA connector is written.** Creating a channel of a type with no
connector is already refused, so the gap is visible rather than latent. Writing
an Agoda adapter needs its certification pack — endpoint URLs, message schemas
and a test account — and an adapter written against a guess at the wire format
would pass the contract suite while being wrong about the protocol, which is
worse than not having one. Everything up to that point is built: the port, the
registry, the contract test suite the Mock OTA passes, mapping, ARI assembly,
retry and dead-lettering, inbound webhooks, test-connection and forced sync.

### 6.9 Inbound webhooks (OTA → DeeHub)

```
POST /webhooks/channels/{channelId}    X-DeeHub-Signature: <hmac-sha256>
```

Unauthenticated by JWT; authenticated by per-channel HMAC signature over the
raw body, verified before parsing.

**Store-then-process, always.** The handler persists the raw payload to
`channel_reservations` (unique on `(channel, externalReservationId)`) and
returns `202 Accepted` immediately; mapping and reservation creation happen
in the worker. OTAs retry aggressively on slow responses, and processing
inline would turn one booking into several. Deduplication is the unique
index, so redelivery is a no-op.

Unmappable payloads are stored with `status: FAILED` and surfaced in the
dashboard for staff resolution — never dropped
([domain-model.md §3.8](domain-model.md)).

### 6.10 Notifications

| Method | Path                                                                          | Capability          |
| ------ | ----------------------------------------------------------------------------- | ------------------- |
| `GET`  | `/properties/{pid}/notifications?status=&kind=&reservationId=&cursor=&limit=` | `notification:read` |

Read-only, and there is deliberately no endpoint for sending one by hand. A
message exists because something happened to a booking; a "send this" button
would let staff mail a guest anything from the hotel's address with no booking
behind it and nothing in the audit trail saying why.

Each item carries the RENDERED `subject` and `body` — what was actually sent,
not what the current template would produce. Every page also carries `summary`,
the counts by status across the whole property, so the screen can lead with the
failures rather than making someone scroll to find them.

**Three kinds today**: `BOOKING_CONFIRMED` and `BOOKING_CANCELLED` to the guest
by email, `BOOKING_RECEIVED` to the desk by email and LINE when a channel sells
a room. A modification sends nothing: "your booking changed" is only useful if
it says what changed, and the event carries affected dates rather than a
before-and-after a guest could read.

**Four statuses.** `SENT` and `FAILED` mean what they say. `PENDING` is waiting
for the next dispatch pass. `SKIPPED` means nobody was ever going to receive it
— no address on file, or no provider configured — which is a different thing to
tell an operator than a failure, and the row says which.

### 6.11 Audit and platform

| Method | Path                                                           | Capability                    |
| ------ | -------------------------------------------------------------- | ----------------------------- |
| `GET`  | `/audit-logs?entityType=&entityId=&actorId=&from=&to=&cursor=` | `audit:read`                  |
| `GET`  | `/health`                                                      | public — liveness             |
| `GET`  | `/health/ready`                                                | public — DB + Redis readiness |

---

## 7. Rate limiting

Per-IP on auth endpoints (10 attempts / 15 min), per-organization on the rest
(default 600 req/min). Responses carry `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`; 429 carries `Retry-After`.
Webhook endpoints have a separate, higher budget — throttling an OTA causes
retries and duplicate deliveries.

---

## 8. OpenAPI and the SDK

- Controllers and DTOs are annotated with `@nestjs/swagger`; the document is
  served at `/api/v1/docs` (UI) and `/api/v1/docs-json`.
- CI generates `packages/sdk` from that JSON and **fails the build if the
  committed SDK differs** — client and server types cannot drift.
- The same zod schemas in `packages/shared` validate on both sides.
- Every endpoint documents its error codes, not just its success shape.

---

## 9. Security requirements

- HTTPS only; HSTS; Helmet defaults; CORS restricted to known dashboard
  origins.
- `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true` —
  unknown fields are rejected, so mass-assignment is impossible.
- `organizationId` is never accepted from a client on any endpoint.
- No secrets or PII in URLs (query strings reach logs); search terms that
  contain guest data go in `q` and are redacted in structured logs.
- Responses never include password hashes, tokens, or channel credentials —
  enforced by explicit response DTOs rather than entity serialization.
- Every mutating endpoint writes an audit log entry (Definition of Done).

---

## 10. Open items

1. Booking-engine public API (Phase 3) will be a separate unauthenticated,
   heavily rate-limited surface under `/api/v1/public/` — not designed here.
2. Payments endpoints arrive with Phase 3.
3. Reporting endpoints (occupancy, ADR, RevPAR) arrive in Phase 4; the shape
   should follow the same grid convention as inventory.
4. Webhook _outbound_ (DeeHub → customer systems) is not planned for
   Milestone 1.
