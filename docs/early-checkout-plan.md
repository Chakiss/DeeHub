# Early Check-Out — Plan

Return a room to sale the moment the guest actually leaves, instead of the next
morning. Written before any code, per `CLAUDE.md`.

Found by the first pilot property (The Let's Chill Resort Pattaya @ Huayyai, 7
rooms across 2 types) in its first week, described as a problem their current
system has and every system they have tried has:

> ลูกค้าเข้าตอนเที่ยง เรากด check-in พอตอนเย็นลูกค้า check-out
> ระบบไม่มีให้เลือก check-out ในวันนั้น ต้องรอวันถัดไป ทำให้เปิดรับการจองเพิ่มไม่ได้

**DeeHub has the same gap today**, for a different and documented reason. This
plan closes it.

---

## 1. Business Goal

A room standing empty from 18:00 is a room that can still be sold tonight. At
฿1,300 a night on a property with five bungalows, every occurrence is about 1%
of a month's room revenue — and the pilot says it happens constantly.

The goal is not a discounted day-use product. **The first guest still pays in
full**; the hotel simply stops being blocked from selling a room nobody is in.

---

## 2. What today's code does, precisely

Neither existing operation fits, and the reasons are worth stating because both
were deliberate.

| Operation                 | Inventory              | Folio                 | Fits?                           |
| ------------------------- | ---------------------- | --------------------- | ------------------------------- |
| `check-out.usecase.ts`    | **keeps** the nights   | untouched             | No — room stays unsellable      |
| `shorten-stay.usecase.ts` | releases future nights | **removes** the money | No — the hotel is not refunding |

Both are built on one assumption, and it is the only thing wrong here:

**"Checked in" has meant "consumed tonight".** A guest who left at six did not
consume tonight. The room is empty, the night is unsold, and the software is the
only thing that disagrees.

Nothing else in the reservation model needs to change — not the state machine,
not the pricing, not the constraint that a stay covers at least one night. The
booking stands exactly as taken. What has to become expressible is that its room
went back on sale before the night it was holding.

---

## 3. Functional Requirements

| #   | Requirement                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- |
| F1  | At check-out, the desk can choose to return the nights the guest will not occupy to sale                    |
| F2  | Releasing is refused for nights already slept — only today's night and later                                |
| F3  | The money for released nights stays with the hotel: the booking is untouched, so the folio is too           |
| F4  | Occupancy counts a released night once — for whoever bought it second, never for both                       |
| F5  | The vacated room becomes `DIRTY` and cannot be handed to the next guest until housekeeping clears it        |
| F6  | The screen states plainly, before the click, that the room will be offered for sale again immediately       |
| F7  | Audit records who released which nights, and what was charged for them                                      |
| F8  | Every report that counts room nights subtracts the released ones, so occupancy cannot exceed the rooms sold |

**Out of scope:** hourly pricing, a discounted day-use rate plan, selling day-use
through an OTA (no OTA sells it), and automatic re-assignment of the freed room.

---

## 4. Database Design

**Revised after reading the schema.** The first draft of this section proposed
truncating the stay to zero nights and re-posting the money as a folio charge.
That is not buildable as written, and the thing that stops it is worth keeping:

```sql
check ('stays_date_order_ck', check_out > check_in)
```

A zero-night stay is refused by the database, not merely by a use case. Relaxing
that constraint to allow one operation would remove the guarantee for every
other one — the whole booking path relies on a stay covering at least one night.

So the design inverts. **The stay keeps its dates; only the inventory moves.**

One column, on `reservation_stays`:

```
nights_released_early  smallint  not null  default 0
```

Everything else follows from leaving the booking alone:

| Concern        | What happens                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The money      | Nothing to do. Room charges derive from the booking's frozen nights, and the booking is untouched, so the guest stays charged in full |
| The room       | `inventory.release()` on the nights from today onward — the same call `shorten-stay` makes                                            |
| Occupancy      | Reports count `nights − nights_released_early` for the stay                                                                           |
| The constraint | Untouched, and still true                                                                                                             |

**This is smaller, and it is also more honest.** The booking really was for one
night, it really was paid in full, and the room really was handed back. Three
facts, three fields, no compensating entry that has to be kept in step with
anything.

### What the numbers do afterwards

Guest A pays ฿1,300 for tonight and leaves at 18:00. Guest B buys the same night
at 20:00 for ฿1,300.

- Rooms sold tonight: **1** — A's night is subtracted, B's counts
- Room revenue tonight: **฿2,600** — both paid, both real
- ADR tonight: **฿2,600**, which is not a glitch. The property genuinely earned
  that from one room, and a hotelier looking at it should see exactly that.

---

## 5. API Design

```
POST /properties/{propertyId}/reservations/{id}/check-out
  { expectedVersion, releaseRemainingNights?: boolean }   default false

200 { status: 'CHECKED_OUT', outstandingBalance, currency,
      nightsReleased: number, roomsToClean: string[] }
409  version mismatch
422  nights already slept cannot be released
```

**One endpoint, not two.** Check-out is a single act at the desk; a separate
"release the room" call is a second step a busy person forgets, and forgetting it
leaves exactly the locked room this plan exists to unlock. The flag defaults to
today's behaviour, so nothing changes for callers that do not ask.

---

## 6. Folder Structure

Existing module, no new one:

```
apps/api/src/modules/reservations/application/check-out.usecase.ts   extended
apps/api/src/database/schema/reservation.ts                          one column
apps/admin-web/src/app/.../check-out-dialog.tsx                      the choice
```

---

## 7. Implementation Plan

| Step | Deliverable                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 1    | Migration: one `nights_released_early` column on `reservation_stays`                                    |
| 2    | Use case: release nights from today, mark the room dirty, publish the inventory event — one transaction |
| 3    | Integration tests, including two desks releasing the same night concurrently                            |
| 4    | Check-out dialog: the choice, worded as a consequence rather than a checkbox                            |
| 5    | Reports: day-use revenue as its own line                                                                |
| 6    | Channel push, so the freed night reaches the OTAs — behind `enable_channel_sync`                        |

Steps 1–4 are the pilot's whole problem. Step 5 keeps their numbers honest.
Step 6 only matters once a channel is connected.

---

## 8. Test Cases

| #   | Test                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| T1  | One-night stay, check out same day with release → allotment for tonight returns to its pre-booking count                   |
| T2  | ...and the folio total is unchanged: the guest is still charged for the night they left                                    |
| T3  | ...and the stay keeps its dates, with `nights_released_early = 1` recording what happened                                  |
| T4  | Three-night stay, leaves on night two → the two remaining nights are released, night one is not                            |
| T5  | Release refused for a night in the past                                                                                    |
| T6  | The freed night can immediately be booked by a second reservation, and the room is `DIRTY` until cleaned                   |
| T7  | Two desks releasing the same stay concurrently → one succeeds, one gets a version mismatch, allotment rises by exactly one |
| T8  | Check-out without the flag behaves exactly as today (regression guard)                                                     |
| T9  | Occupancy for that night counts one room sold, not two                                                                     |

---

## 9. Risks

| Risk                                                                                                                      | Response                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The guest comes back.** Released at 18:00, resold at 20:00, the first guest returns at 22:00 having gone out for dinner | The dialog says the room goes on sale immediately and asks for the key back first. This is an operational risk the software can warn about and not prevent |
| **Sold before it is cleaned.** The night returns to sale in seconds; housekeeping takes an hour                           | The night is sellable, the ROOM is not assignable while `DIRTY` (F5). Availability and readiness are different questions                                   |
| The desk uses release for a guest who is owed a refund                                                                    | Two clearly different buttons with different words — "ย่นวันเข้าพัก" refunds, "เช็กเอาต์เร็ว" does not                                                     |
| An OTA sells the freed night minutes later                                                                                | That is the point. Worth stating out loud during pilot onboarding so nobody is surprised                                                                   |
| Zero-night stays confuse a report written before they existed                                                             | T9, and every report that counts nights gets a case for it                                                                                                 |

---

## 10. Future Improvements

- A real day-use product: its own rate, sold on the booking page, at a price that
  is not the overnight rate
- Same-day re-assignment that suggests the freed room once housekeeping clears it
- A "the guest came back" reversal, if the pilot reports it happening

---

## The one thing to decide

**Does the freed night go back as "one more of this room type", or as "room 3 specifically"?**

This plan assumes the former, consistent with ADR-0002: inventory is a count per
room type per night, and physical rooms exist for assignment and housekeeping
only. A seven-room property's desk already knows which room is empty; what it
needs from the software is permission to sell, not a room chosen for it.

If the pilot turns out to think in room numbers, the count still works and only
the assignment screen changes — which is why this is safe to build first and ask
about second.
