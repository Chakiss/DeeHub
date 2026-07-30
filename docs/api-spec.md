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

| Method  | Path                    | Purpose                                                                             |
| ------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `POST`  | `/auth/login`           | email + password → access token + refresh cookie                                    |
| `POST`  | `/auth/refresh`         | rotate refresh token → new access token                                             |
| `POST`  | `/auth/logout`          | revoke the current refresh token                                                    |
| `GET`   | `/auth/me`              | current user, memberships, accessible properties                                    |
| `POST`  | `/auth/change-password` | change your own password; revokes every other session                               |
| `GET`   | `/users`                | people in the organization and their roles                                          |
| `POST`  | `/users`                | create an account; returns a one-time password (no outbound email yet)              |
| `PATCH` | `/users/{id}`           | change name, role or status; `DISABLED` replaces deletion                           |
| `POST`  | `/auth/forgot-password` | **planned** — send reset email (always 202, never reveals whether the email exists) |
| `POST`  | `/auth/reset-password`  | **planned** — consume reset token                                                   |

Everything above without a **planned** marker is implemented.

Account recovery today is operator-driven: someone with `user:update` calls
`POST /users/{id}/reset-password` and reads the new credential out. That is a
deliberate stopping point rather than an oversight — self-service reset means
sending mail, and there is no mail provider configured. An endpoint that
answered 202 and sent nothing would be worse than none, because the person
would wait for an email that never arrives. Choosing a provider is what unblocks
`forgot-password` / `reset-password`.

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

| Method  | Path                                              | Capability                                         |
| ------- | ------------------------------------------------- | -------------------------------------------------- |
| `GET`   | `/properties/{pid}/reservations`                  | `reservation:read`                                 |
| `POST`  | `/properties/{pid}/reservations`                  | `reservation:create`                               |
| `GET`   | `/properties/{pid}/reservations/{id}`             | `reservation:read`                                 |
| `PATCH` | `/properties/{pid}/reservations/{id}`             | `reservation:update` — contact/notes only          |
| `POST`  | `/properties/{pid}/reservations/{id}/modify-stay` | `reservation:modify` — dates, room type, occupancy |
| `POST`  | `/properties/{pid}/reservations/{id}/confirm`     | `reservation:update`                               |
| `POST`  | `/properties/{pid}/reservations/{id}/cancel`      | `reservation:cancel`                               |
| `POST`  | `/properties/{pid}/reservations/{id}/check-in`    | `reservation:checkin`                              |
| `POST`  | `/properties/{pid}/reservations/{id}/check-out`   | `reservation:checkout`                             |
| `POST`  | `/properties/{pid}/reservations/{id}/no-show`     | `reservation:update`                               |
| `GET`   | `/properties/{pid}/reservations/{id}/audit`       | `audit:read`                                       |

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
| `POST`        | `/properties/{pid}/channels/{id}/test-connection` | `channel:update`                  |
| `GET` `PUT`   | `/properties/{pid}/channels/{id}/mappings`        | `channel:read` / `channel:update` |
| `POST`        | `/properties/{pid}/channels/{id}/sync`            | `channel:sync` — force full sync  |
| `GET`         | `/properties/{pid}/channels/{id}/sync-jobs`       | `channel:read`                    |
| `GET`         | `/properties/{pid}/channels/{id}/health`          | `channel:read`                    |

Credentials are write-only: accepted on `POST`/`PATCH`, never returned. Reads
show `"credentialsConfigured": true` and nothing more.

`/health` powers the dashboard's channel status strip — last successful sync,
queue depth, consecutive failures. A stalled sync is the failure mode that
causes overbookings, so it gets a first-class endpoint rather than being
buried in logs.

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

### 6.10 Audit and platform

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
