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

`shorten-stay` also refuses to leave a stay with no nights at all:

> _A stay must keep at least one night. Cancel the booking instead of shortening
> it to nothing._

That guard is right about a **live** booking — a zero-night reservation holds no
inventory, appears on no night, and nobody ever closes it. It is wrong about a
**completed** one. A guest who arrived at noon and left at six is a fact that
happened; the record of it is not a ghost.

**This is the single assumption to overturn: "checked in" has meant "consumed
tonight". It does not.**

---

## 3. Functional Requirements

| #   | Requirement                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- |
| F1  | At check-out, the desk can choose to return the nights the guest will not occupy to sale                    |
| F2  | Releasing is refused for nights already slept — only today's night and later                                |
| F3  | The money for released nights stays with the hotel, as a **posted charge**, not as a phantom occupied night |
| F4  | A completed stay may hold zero nights; a live booking still may not                                         |
| F5  | The vacated room becomes `DIRTY` and cannot be handed to the next guest until housekeeping clears it        |
| F6  | The screen states plainly, before the click, that the room will be offered for sale again immediately       |
| F7  | Audit records who released which nights, and what was charged for them                                      |
| F8  | Reports separate day-use revenue from room-night revenue so ADR and RevPAR stay comparable                  |

**Out of scope:** hourly pricing, a discounted day-use rate plan, selling day-use
through an OTA (no OTA sells it), and automatic re-assignment of the freed room.

---

## 4. Database Design

No new table. Three changes:

1. `reservations.nights_released_early` — the count released this way, so a
   completed zero-night stay is distinguishable from a data error.
2. The zero-night guard moves from "any stay" to "any **open** stay". A
   `CHECKED_OUT` reservation whose `check_out` equals its `check_in` becomes
   legal, and only reachable through this operation.
3. Folio charge kind `EARLY_DEPARTURE_NIGHT`, so the money that used to be a
   derived room night becomes an explicit posted line.

Migration is additive: a nullable column and a new enum value. Nothing existing
changes meaning.

### Why the money has to move from derived to posted

Room charges are derived from the booking's frozen night prices
(`decisions-pending-review.md` §15) — the folio has no copy. So releasing a
night removes its money automatically, which is right for `shorten-stay` and
wrong here.

Keeping the night on the booking instead would keep the money, but then the
night is sold twice in the occupancy report: once to the guest who left and once
to whoever buys it at 20:00. **A property with two Triple Standards would show
150% occupancy.** Posting the charge is the only arrangement where revenue and
occupancy are both true.

---

## 5. API Design

```
POST /properties/{propertyId}/reservations/{id}/check-out
  { expectedVersion, releaseRemainingNights?: boolean }   default false

200 { status: 'CHECKED_OUT', outstandingBalance, currency,
      nightsReleased: number, earlyDepartureCharge: number }
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
apps/api/src/modules/folio/domain/charge-kind.ts                     new kind
apps/admin-web/src/app/.../check-out-dialog.tsx                      the choice
```

---

## 7. Implementation Plan

| Step | Deliverable                                                                                 |
| ---- | ------------------------------------------------------------------------------------------- |
| 1    | Migration: column, enum value, and the guard moved to open stays only                       |
| 2    | Use case: release nights from today, post the charge, mark the room dirty — one transaction |
| 3    | Integration tests, including two desks releasing the same night concurrently                |
| 4    | Check-out dialog: the choice, worded as a consequence rather than a checkbox                |
| 5    | Reports: day-use revenue as its own line                                                    |
| 6    | Channel push, so the freed night reaches the OTAs — behind `enable_channel_sync`            |

Steps 1–4 are the pilot's whole problem. Step 5 keeps their numbers honest.
Step 6 only matters once a channel is connected.

---

## 8. Test Cases

| #   | Test                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| T1  | One-night stay, check out same day with release → allotment for tonight returns to its pre-booking count                   |
| T2  | ...and the folio total is unchanged, with the money now on an `EARLY_DEPARTURE_NIGHT` line                                 |
| T3  | ...and the reservation is `CHECKED_OUT` holding zero nights, which the API still returns intact                            |
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
