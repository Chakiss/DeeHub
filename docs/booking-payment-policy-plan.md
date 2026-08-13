# Booking engine — payment deadline, cancellation policy, auto release

Written 2026-08-13, from pilot feedback. Three requirements, one of which
("auto release") was asked about rather than specified, so §2 answers it before
§3 plans it.

---

## 1. What the founder asked for

1. Tell the guest to pay **100% within 24 hours** of booking.
2. State the cancellation policy: **less than 24 hours before check-in, no
   refund; 24 hours or more, 50% refunded.**
3. Auto release — find out what it is and whether we need it.

## 2. Auto release: two different features with one name

**(a) Allotment release — a channel-manager term.** A property contracts N
rooms to an agent or OTA; whatever is unsold is automatically released back to
the general pool a set number of days before arrival. It exists because the
inventory was split per channel in the first place.

**DeeHub does not need this.** [ADR-0002](adr/0002-count-based-inventory.md)
makes availability one shared count per room type per night — every channel sees
the same pool, nothing is reserved for anyone, so there is nothing to release.
Splitting allotment per channel is noted as a possible future extension in
`database.md` §14 and would be the thing that creates this need. It is not on
the roadmap and should not be.

**(b) Releasing an unpaid booking — a booking-engine term.** A booking that is
not paid by its deadline is cancelled automatically and the room goes back on
sale. This is the one that belongs next to requirement 1, and it is what "auto
release" means in the context the founder asked it in.

**Most of (b) already exists.** `ExpireHoldsUseCase`
(`inventory/application/expire-holds.usecase.ts`) sweeps `PENDING` reservations
whose `hold_expires_at` has passed, releases their nights, audits it and emits
the events that re-push availability to every channel. Its own comment names the
reason it exists: without it, an unfinished checkout holds a room forever, and
an attacker could hold an entire small hotel by starting bookings and never
paying.

What is missing is that **the window is a 15-minute constant, not a policy** —
`DEFAULT_HOLD_TTL_SECONDS = 900`.

### The prerequisite, checked and already met

`ExpireHoldsUseCase` only runs from the maintenance job, and that job was
paused in production from 2026-08-11. Nothing released an expired hold while it
was. Shipping a 24-hour payment window onto that would have taken a room off
sale for a day per unpaid booking and never given it back — on a 7-room
property, a handful of abandoned bookings is the whole hotel.

**Verified 2026-08-13 and no longer a blocker.** `terraform plan` reports
`No changes`, the scheduler is `ENABLED` with `retryCount: 1`, and the eight
most recent executions all succeeded ten minutes apart. The release path runs.

The check itself is worth repeating before this ships, because the risk is not
that the job is paused — it is that the job is paused _and nobody notices_. The
failure is silent by construction: rooms simply stop coming back.

```bash
gcloud run jobs executions list --job=deehub-maintenance-prod \
  --region=asia-southeast1 --project=deehub-hotel --limit=5
```

## 3. Business goal

A guest booking direct knows what they must pay, by when, and what happens if
they cancel — and a room nobody paid for goes back on sale by itself.

## 4. Functional requirements

### 4.1 Payment deadline

- The payment window is **a policy on the rate plan**, defaulting to 24 hours,
  not a constant in the code.
- Booking through the public API creates the reservation as `PENDING` with
  `hold_expires_at` set from that policy, and returns the deadline.
- The guest is told the amount, the deadline as an absolute time in the
  property's timezone, and how to pay. A reminder goes out before expiry.
- Paying in full moves the reservation to `CONFIRMED` and clears the hold.
- The deadline never runs past check-in: a booking made for tomorrow gets a
  window that ends before arrival, not 24 hours later.

This is a **different flow from the one that exists.** Today the public API
holds a room for fifteen minutes and expects payment inside that window
(`decisions-pending-review.md` §17). The new flow is book-now-pay-later, and
both are legitimate — the 15-minute one for a card checkout, the 24-hour one for
a bank transfer or PromptPay. The rate plan decides which applies.

**The trade-off to accept deliberately:** a 24-hour window holds real inventory
for 24 hours. That is the point (the guest's room is genuinely theirs), and it
is expensive for a 7-room property. It is also the availability-denial vector
the sweeper's comment warns about, at 96× the duration. Worth pairing with a
cap on concurrent unpaid holds per email or phone number.

### 4.2 Cancellation policy

The rule as given:

| Cancelled                        | Refund |
| -------------------------------- | ------ |
| 24 hours or more before check-in | 50%    |
| Less than 24 hours before        | 0%     |

- The deadline is computed from the property's **check-in time on the arrival
  date in the property's timezone** — `properties.check_in_time`, default
  `14:00`, which already exists. A stay arriving 2026-09-10 has a deadline of
  2026-09-09 14:00 Asia/Bangkok.
- One comparison, no ambiguity at the boundary: `hours_before >= 24` refunds
  50%, everything else refunds nothing. "23.59 hours" and "24 hours" are the two
  sides of that single test.
- **The policy is frozen onto the booking**, exactly as the price already is.
  A policy edited in September must not change what a guest agreed to in August.
- It is displayed before the guest confirms, and repeated in the confirmation
  email.
- Refunds post to the folio, which already handles payments, refunds by method
  and voids. Card refunds go back through Omise.

**Three questions for the founder**, because guessing them produces a policy
nobody chose:

1. Is a cancellation six months out really 50%? Most hotels refund in full far
   in advance and tighten as arrival approaches. The rule as stated has one
   step; two or three is more common.
2. Is the 50% of the **whole stay** or of the **first night**?
3. What does a no-show pay — the same as a late cancellation, or the full stay?

The mechanism is the same either way, so these can be answered after the work
starts, but not after it ships.

### 4.3 Auto release

- The sweeper releases an unpaid `PENDING` reservation at its deadline —
  already built.
- It gains: a cancellation notice to the guest saying why, a reason recorded on
  the reservation so the desk can tell an expiry from a staff cancellation, and
  a dashboard count of what was released.

## 5. Database

```sql
ALTER TABLE rate_plans
  ADD COLUMN payment_window_hours smallint NOT NULL DEFAULT 24
    CHECK (payment_window_hours BETWEEN 0 AND 720),
  ADD COLUMN cancellation_free_hours smallint NOT NULL DEFAULT 24,
  ADD COLUMN cancellation_refund_percent smallint NOT NULL DEFAULT 50
    CHECK (cancellation_refund_percent BETWEEN 0 AND 100);
```

Frozen onto the reservation at booking time, alongside the price snapshot that
already exists. `payment_window_hours = 0` means pay immediately — which is how
the existing 15-minute card flow keeps working unchanged.

## 6. API

- `POST /public/{org}/{property}/bookings` returns `paymentDeadline` and the
  cancellation terms that were frozen onto the booking.
- `GET /public/{org}/{property}/bookings/{code}` lets a guest see the deadline
  and pay before it.
- `POST .../cancel` quotes the refund the frozen policy produces, then performs
  it.
- The desk sees the same numbers on the booking screen, and can override with a
  reason — a refund decision is a human's, and the policy is the default rather
  than the law.

## 7. Test cases

- A booking on a 24-hour plan expires at exactly 24 hours and its nights return
  to availability.
- A booking for tomorrow gets a deadline before check-in, not after.
- Paying in full before the deadline confirms the booking and clears the hold.
- Paying **as the sweeper runs** resolves one way, deterministically, and never
  both takes the money and releases the room.
- Cancelling at 24:00:01 before check-in refunds 50%; at 23:59:59, nothing.
- The boundary is computed from the property's check-in time and timezone, not
  from UTC midnight.
- A policy changed after a booking does not change that booking's refund.
- An expired booking's release re-pushes availability to every active channel.
- A guest receives the deadline notice, the reminder, and the release notice.

## 8. Risks

| Risk                                                                                                      | Mitigation                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The maintenance job stops and nothing releases anything — silently, because rooms merely stop coming back | Running and verified 2026-08-13 (§2); re-check with the command there before shipping, and treat a paused sweeper as a release blocker |
| A 24-hour hold blocks a 7-room property's inventory                                                       | Cap concurrent unpaid holds per contact; make the window a per-rate-plan setting                                                       |
| Payment and expiry race                                                                                   | One transaction decides; tested explicitly                                                                                             |
| Refund policy applied to an OTA booking                                                                   | OTA bookings are cancelled under the OTA's policy, not ours — the frozen policy must record which one applies                          |
| 50% refunded on a booking the OTA already collected for                                                   | Direct bookings only; the folio is the source of truth for what we actually hold                                                       |

## 9. Rollback

Every column has a default that reproduces today's behaviour
(`payment_window_hours = 0` for the existing 15-minute card flow;
cancellation columns unused until the UI reads them). The sweeper change is
additive — it already releases holds, it would only start explaining why.

## 10. Future improvements

- Tiered cancellation policies (100% until 7 days, 50% until 24 hours, 0%
  after), which is where question 1 in §4.2 leads.
- Deposit percentages rather than 100%, the open question from
  `decisions-pending-review.md` §17.
- No-show handling as its own state with its own charge.
