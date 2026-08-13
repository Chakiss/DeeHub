# Channel rate markup — selling higher on an OTA than direct

Written 2026-08-13, from pilot feedback after the founder compared DeeHub
against the channel manager the property runs today (eZee Centrix, by Yanolja).

**Status: built, same day.** Migration `0011_nifty_firedrake.sql`, the markup
applied in `push-ari.usecase.ts`, the inbound price fix in §5, and the
dashboard field — with six new tests. One departure from this plan is marked in
§4; §5's open question is still the founder's.

---

## 1. Business goal

**OTA-facing prices must be the property's own rate plus 80%,** so that after an
OTA's discounting, its commission and tax, the hotel is not selling at a loss —
and so a guest booking direct is never quoted more than a guest booking through
an OTA.

This is not a new policy to invent. The pilot property already runs it: in
eZee's _Distribution → Rate Plan Mappings_ screen there is a **Rate Multiply
Factor** of `1.8000` on every mapped rate plan, on all four channels — Agoda,
Expedia, CTrip and Booking.com. DeeHub cannot replace that channel manager
without it. A property switching to DeeHub today would silently start selling
every OTA room at 55% of the price it charges now.

Same screens tell us two more things worth copying:

- Mapping granularity is **per channel, per rate plan** — a `Rate Plan Map Id`
  and a `Room Type Map Id` per row. DeeHub's mapping tables already match this
  shape.
- There is a **Fetch Room Mapping Information** button that pulls the channel's
  own identifiers rather than making a human type them. That is the
  `fetchCatalog` operation proposed in
  [ADR-0007](adr/0007-connector-port-extension.md) §5.2 — independently
  confirmed as table stakes.

## 2. Functional requirements

1. A multiplier can be set **per channel, per rate plan**, defaulting to
   `1.0000` (no markup) so nothing changes until someone sets one.
2. The multiplier applies **only to the price pushed to that channel.** Direct
   bookings, the front desk, the rate grid's own numbers, reports and existing
   reservations are untouched.
3. The dashboard shows the resulting OTA-facing price next to the base rate.
   A markup nobody can see is a markup nobody can check.
4. Changing a multiplier is audited and triggers a re-push of the affected
   horizon — otherwise the OTA keeps selling yesterday's price.
5. A multiplier below `1.0` is allowed but warned about in the UI; `0` or
   negative is refused.

## 3. Non-functional requirements

- **No floating point.** Money is integer minor units everywhere in this
  system, and a markup is exactly where a naive `× 1.8` starts producing
  `1799.0999999999999`.
- One implementation, one place. Applying the markup inside connectors would
  mean four adapters each rounding slightly differently.
- Recomputing the same night twice gives the same number, or `pushAri` stops
  being idempotent in practice even though it is in principle.

## 4. Where it goes

`channel_rate_plan_mappings` gains one column:

```sql
ALTER TABLE channel_rate_plan_mappings
  ADD COLUMN rate_multiplier_bp integer NOT NULL DEFAULT 10000
    CHECK (rate_multiplier_bp BETWEEN 1 AND 100000);
```

**Basis points, not the `numeric(6,4)` this plan first proposed.** The change
came from reading the code: `applyBasisPoints` already exists in
`packages/shared/src/money.ts` and is how tax and service charge are already
computed (`properties.tax_rate_bp`). A decimal factor would have needed a
conversion into a JS number on every read — the one thing §3 says not to do —
to reach a helper that takes an integer anyway. 10000 is ×1.0, 18000 is ×1.8.

On the mapping row rather than on `channels`, because that is the granularity
the incumbent uses and because two rate plans on one channel can carry different
commission. Defaulting to `10000` makes the migration inert: every existing row
keeps behaving exactly as it does now.

**The application point is `push-ari.usecase.ts:122–134`** — the loop that turns
rate rows into `AriRate`. That is the only place in the codebase where a price
becomes a price-for-a-channel. Nothing else moves.

Order of operations, stated because it is guessable in two directions:

1. The rate view resolves derived rate plans first (a plan priced as an offset
   from its parent — the decision recorded in
   `decisions-pending-review.md` §16).
2. **Then** the channel multiplier applies to the resolved amount.

So a non-refundable plan at 10% below its parent, pushed to Agoda at 1.8×,
reaches Agoda at `parent × 0.9 × 1.8`. The alternative order would make the
discount itself 80% bigger, which nobody intends.

Rounding: integer arithmetic on minor units, half-up, to the nearest minor
unit — `applyBasisPoints`, unchanged and already tested.

## 5. The bug this feature exposes

**An OTA booking is priced from our own rate plans and ignores what the OTA
actually charged the guest.**

`deliver-reservation.usecase.ts:162` calls `CreateReservationUseCase` with a
room type, a rate plan, dates and occupancy — and no amount.
`CreateStayInput` (`create-reservation.usecase.ts:32`) has no price field at
all, so the reservation is priced from the property's own rates.

Today that is nearly harmless: what we push is what we charge, so the two agree.
**The moment a multiplier exists, they stop agreeing.** Push 1,800 to Agoda,
Agoda sells at 1,800, the booking comes back — and DeeHub records a reservation
worth 1,000. The folio, the guest's bill at the desk, ADR and RevPAR are then
all wrong by 44%, and wrong in the direction that makes a hotel think its OTA
business is unprofitable.

The channel's own figure is not lost — `InboundReservation.totalMinor` is
parsed by every connector and stored in the raw payload. It is discarded at
mapping time.

**This must ship with the markup, not after it.** The fix is a price override
on the channel delivery path only:

- `CreateStayInput` accepts an optional frozen amount, settable **only** by the
  channel delivery path — the same restriction already applied to
  `onInsufficientInventory`, whose comment says "Only the channel delivery path
  may relax this".
- When the channel sends a total, that total is what the booking is worth.
- When it does not, we fall back to our own rates and **record that we did**,
  because a silent fallback here is a wrong number nobody can find later.

One decision belongs to the founder: the channel's figure is the **gross** price
the guest paid, not what the hotel will be paid after commission. Recording
gross is the right default — it is what the guest sees and what a reconciliation
against the OTA statement compares against — but net revenue then needs a
commission field per channel, which is a later piece of work rather than a field
to invent now.

## 6. API and UI

- `PUT /properties/:propertyId/channels/:channelId/mappings` accepts
  `rateMultiplierBp` on each rate-plan mapping — the existing replace-the-set
  endpoint, rather than a second one, because mappings are already a set.
  Room-type mappings do not accept it and the schema is strict, so sending it
  there is refused rather than ignored.
- The channel screen's rate-plan table gains an **OTA price factor** column,
  typed as a decimal (`1.8`) because that is what the incumbent's screen shows
  and what an operator will be copying across at cutover.
- Changing a mapping writes `RATE_CHANGED` to the outbox for every affected
  room type across the channel's horizon, so the relay re-pushes. Without it a
  markup change moves no rate row and nothing else would notice.

**Not built:** the per-channel preview row on the rate grid. The factor and its
effect are visible on the channel screen; putting it on the grid as well is a
second surface to keep honest, and worth doing only once somebody has missed it.

## 7. Test cases

- `1.8000 × 1,000.00` pushes exactly `1,800.00`, with no float artefact.
- `1.8000 × 999.50` rounds to a stated, tested value rather than whatever the
  runtime produces.
- A multiplier of `1.0000` produces byte-identical output to today.
- A derived rate plan is resolved **before** the multiplier, and the resulting
  number is asserted end to end.
- Direct booking, front desk and reports are unaffected by any multiplier.
- An OTA booking whose payload carries a total is stored at that total, not at
  the base rate.
- An OTA booking with no total falls back to our rates and records the fallback.
- Changing a multiplier writes an audit entry and enqueues a re-push.
- `0`, a negative multiplier and a multiplier above `10` are refused by the
  database, not only by validation.

## 8. Risks

| Risk                                                                                       | Mitigation                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Double markup at cutover** — eZee applies 1.8 and DeeHub applies 1.8 to the same channel | The cutover is a scheduled switch, never a parallel run. Verify the OTA extranet price after the first push                                               |
| OTA rate parity clauses in the property's contracts                                        | The property already prices this way through its current channel manager; this changes nothing commercially, but the contracts are the founder's to check |
| Wrong booking values on every OTA reservation                                              | §5 ships with the feature, not after it                                                                                                                   |
| A markup set on one rate plan and forgotten on another                                     | The channel screen shows every mapped plan's multiplier in one list, and flags any row still at 1.0000 when its siblings are not                          |
| Rounding disagreement with the OTA's own display                                           | Round in one place, assert it in tests, and check the extranet after the first push                                                                       |

## 9. Rollback

The column defaults to `1.0000` and every code path is a no-op at that value.
Rolling back is setting the multipliers to 1 and forcing a re-push; the column
can stay. The price-override change in §5 is separately revertible and is inert
for any channel that sends no total.

## 10. Future improvements

- **Commission per channel**, so net revenue is reportable alongside gross.
- A fixed-amount markup as well as a multiplier, for properties that think in
  baht rather than percentages.
- Per-date or per-season multipliers, if a property ever asks — deliberately not
  built now, because a multiplier that varies by date is a second pricing
  system, and this one is meant to be a single number a hotelier can explain.
