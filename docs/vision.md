# DeeHub Hotel — Product Vision

## One-liner

An AI-first hotel platform that gives small and mid-size independent hotels
one system for reservations, inventory, rates, and OTA connectivity —
replacing the spreadsheet-plus-extranet chaos they run on today.

## Problem

Independent hotels in Thailand (and Southeast Asia broadly) typically juggle:

- Multiple OTA extranets (Agoda, Booking.com, Expedia…) updated by hand.
- A paper book, spreadsheet, or legacy PMS that doesn't talk to the OTAs.
- No single source of truth for availability — leading to **overbookings**,
  the single most damaging operational failure a hotel can have.
- Rate updates that take hours across channels, so prices lag demand.
- Guest data scattered across channels with no CRM view.

Existing solutions are either enterprise-priced (Opera, Protel), aging
local systems with poor channel management, or fragmented point tools that
still require manual reconciliation.

## Target Customer

- **Primary:** independent hotels, resorts, and hostels in Thailand,
  ~10–150 rooms, selling on 2–6 OTA channels, with a small non-technical
  front-office team.
- **Buyer:** owner or GM. **Daily users:** front desk and reservations staff.
- Expanding later to small chains (multi-property is built in from day one).

## Product

A single platform, sold as SaaS (Organization → Properties), with modules
arriving in this order:

1. **Reservation + Inventory Core** — the source of truth. Count-based
   allotment per room type per night, atomic overbooking guard, full audit
   trail.
2. **Channel Manager** — two-way ARI (availability, rates, inventory) sync
   with OTAs through a uniform connector interface; reservations delivered
   from all channels into one inbox.
3. **Admin Dashboard** — calendar/grid view of inventory and rates,
   reservation management, designed for front-desk speed.
4. **Booking Engine** — commission-free direct bookings on the hotel's own
   website.
5. **PMS operations** — room assignment, check-in/out, housekeeping.
6. **Accounting** — expenses, profit and loss, and the Thai tax paperwork an
   owner cannot avoid: ใบกำกับภาษี, ภ.พ.30, หัก ณ ที่จ่าย. The system already
   holds every baht of revenue; the owner's real question is what is left
   after costs, and today they answer it in a spreadsheet.
7. **Revenue Management, CRM, Analytics** — data products on top of the core.
8. **AI Assistant** — the differentiator (see below).

## Why AI-first

"AI-first" means two things:

- **Built by AI:** AI is the primary developer; the team stays tiny; the
  cost structure allows serving small hotels profitably at a price they can
  afford.
- **AI in the product:** the long-term interface to the platform is an
  assistant that can answer "how did we do last month?", draft rate changes
  for high-demand dates, flag suspicious reservations, and let staff operate
  the system in natural language (Thai or English). Every module is designed
  with clean APIs and event streams so the assistant can act on them safely.

## Differentiators

1. **Overbooking-proof core** — inventory correctness is enforced in the
   database, not by convention; sync conflicts resolve to "never oversell."
2. **Honest SME pricing** — affordable for a 15-room guesthouse, priced per
   property/room, no per-booking commission on direct bookings.
3. **Thailand-first** — THB, Thai VAT + service charge, Asia/Bangkok dates,
   Thai UI (planned), local OTA priorities (Agoda first-class), and the Thai
   tax paperwork produced from the bookings rather than re-typed from them.
4. **AI assistant** on a platform designed for it, not bolted on.

## Success Metrics

- **Milestone 1 (90 days):** production-ready Reservation + Inventory Core
  with Mock OTA sync, admin dashboard, and audit logs; 1–3 pilot properties
  running real inventory on it.
- **Zero overbookings** caused by the platform — the non-negotiable metric.
- Sync latency (inventory change → connector push) under 60 seconds.
- A front-desk user can create a walk-in reservation in under 60 seconds.
- Pilot → paying conversion, then properties onboarded per month.

## Non-goals (for now)

- Enterprise chains, hotel groups with central reservation offices.
- POS, F&B outlets, spa (integrate later, don't build).
- Payroll, social security, and any filing that is a payroll system's job
  (ภ.ง.ด.1) — the accounting module stops at the hotel's own books.
- Bookkeeping _for an accountant_: no double-entry general ledger, no chart of
  accounts, no e-Tax Invoice submission to the Revenue Department. DeeHub
  produces the figures and the supporting reports; a human files the return.
- Global multi-currency selling and metasearch (Google Hotel Ads) — after
  the core proves itself.
- Microservices — modular monolith until scale demands otherwise.
