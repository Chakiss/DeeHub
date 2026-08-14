# ADR-0008: An accounting module, and how its numbers are allowed to exist

- **Status:** Accepted
- **Date:** 2026-08-14
- **Decider:** Founder (reversing a written non-goal), designed by AI (CTO role)

## Context

[vision.md](../vision.md) listed accounting as a non-goal: _"POS, F&B, spa, or
accounting modules (integrate later, don't build)."_ The founder has reversed
that for accounting specifically. This ADR records the reversal and the design
constraints it drags in, because "add accounting" sounds like a CRUD module and
is not one.

Three facts about the existing system shape everything:

1. **Revenue is derived, never posted.** `reservation_stay_nights.amount_minor`
   is frozen at booking; `folio_charges` holds extras; there is no room-charge
   ledger. [schema/folio.ts](../../apps/api/src/database/schema/folio.ts) says
   why, and names the cost: _"a true posted-charge ledger is what a night audit
   needs to freeze a day's revenue, and this cannot do that yet."_
2. **There is no expense side at all.** Every money flow in the system is
   inbound. No vendors, no categories, no purchase documents.
3. **Tax composition already exists and is correct** —
   [pricing.ts](../../apps/api/src/modules/reservations/domain/pricing.ts)
   applies room rate → service charge → VAT on the sum, per Thai practice.

## Decision

Build `modules/accounting` as part of the modular monolith, in four shippable
phases, under six rules.

### 1. The module produces figures. A human files the return.

Every tax report is labelled a worksheet. DeeHub does not submit anything to
the Revenue Department, does not register for e-Tax Invoice, and does not
decide treaty questions. The alternative — software that implies its output is
a filing — turns a hotel's tax exposure into our support burden and their
penalty.

### 2. VAT is not revenue.

Profit and loss counts `subtotal + serviceCharge`. The service charge is the
hotel's revenue even when it is paid out to staff (that payout is a wage
expense). VAT is a liability shown on its own line. Getting this wrong
overstates profit by 7% every month, and it would look plausible.

### 3. Output VAT follows the money, not the night.

Under มาตรา 78/1 the VAT tax point for a **service** arises when payment is
received (or when a tax invoice is issued, whichever is first). A hotel stay is
a service. Therefore:

- **ภ.พ.30 is computed from issued tax documents, not from nightly revenue.**
- A booking deposit creates a VAT liability on the day it is received, while
  remaining unearned revenue on the accrual view. One event, three different
  landings: cash today, output VAT today, accrual revenue at check-in.
- Tax documents are therefore issuable against a **payment**, not only against
  a completed stay.

This is the single most likely way to build the module and be confidently
wrong, so it is written here rather than discovered in an audit.

### 4. One fact, one row, two date dimensions.

We do not store a cash copy and an accrual copy. An expense carries
`expense_date` (accrual — the date on the supplier's invoice) and `paid_date`
(cash, null while unpaid). Revenue is accrual via postings by business date and
cash via `folio_payments` by business date. Reports take a `basis` parameter.
`accounting_settings.taxpayer_type` picks the default — an individual files on
the cash basis (ภ.ง.ด.90/94), a juristic person on the accrual basis
(ภ.ง.ด.50/51) — so the choice is a fact about the taxpayer, not a toggle.

### 5. A posted ledger is allowed, with a reconciler as its price.

`revenue_postings` records what revenue _was_ on a business date, regenerated
idempotently by the maintenance job in the manner of `otb_snapshots`. This does
not contradict §8.1 of [database.md](../database.md). The folio answers _what
does this guest owe right now_; the ledger answers _what was revenue on
2026-07-31_. Those are different questions and the second one cannot be
answered by a live query after the fact.

The copy is permitted **only** because it comes with a drift check modelled on
`ReconcileInventoryUseCase` — report, never repair — comparing postings against
a live recomputation for open periods, and against `posting + adjustments` for
closed ones. A mismatch on a closed period means a change bypassed the
adjustment path, which is a bug alarm, not a rounding difference.

### 6. Immunity has two layers, not one.

- **Periods** freeze postings. An **open** month is regenerated in place; a
  **closed** month is never touched, and a late change becomes an adjustment in
  the current month pointing back at the original date.
- **Tax documents freeze the moment they are issued**, regardless of period
  status. Modifying a stay that has already been receipted requires a credit or
  debit note even if the month is still open. Voiding a tax invoice is only for
  a document issued in error, the original must be recovered, and the number is
  consumed forever — every allocated number keeps a row, which is what makes
  the sequence gapless by construction rather than by effort.

## Consequences

**Accepted costs.** Eleven new tables across four phases. A second place where
revenue exists as a number, justified above and policed by the reconciler. A
first-of-kind print path and CSV export in a codebase that has only ever
returned JSON. Tax rules that are correct on the day they are written and will
need review — the rates and deadlines are data and settings, never constants,
and 7% VAT is stored per document because it is a periodically renewed
reduction from the statutory 10%.

**Gained.** The owner's actual question — _what did I make this month_ — becomes
answerable by the system that already holds the revenue side. And the night
audit gap that Phase 4 of the roadmap has been carrying gets closed on the way.

**Explicitly not built:** payroll and ภ.ง.ด.1, social security, double-entry
general ledger, chart of accounts, e-Tax Invoice integration, abbreviated tax
invoices (ใบกำกับภาษีอย่างย่อ — full-form covers every case), bank and OTA
settlement reconciliation, fixed assets and depreciation.

**Requires a Thai accountant's confirmation before Phase 3 ships**, and must not
be guessed in code: the provincial room levy rate for the property's province,
current e-filing deadline extensions, the line between a refundable security
deposit and an advance payment for VAT purposes, and whether any given OTA's
tax treaty relieves withholding under มาตรา 70.

## Alternatives considered

**Integrate an accounting package instead of building.** The original non-goal.
Rejected for the target customer: a 15-room guesthouse owner is not running
FlowAccount alongside a PMS and reconciling the two by hand — and the revenue
data that any integration would need is already here.

**Double-entry general ledger.** Correct by construction, and the right answer
if an accountant were the user. The user is a hotel owner who has never seen a
journal entry, and a debit/credit model would surface in every screen. Single
entry with immutable rows and categories produces every report Thai law
requires of this taxpayer. A GL can be added later as a projection over these
rows; the reverse is much harder.

**Derive everything, post nothing.** Keeps the "one number, one place" purity of
§8.1 intact. Rejected because a filed month must never move, and a derivation
moves whenever anyone edits an old booking.
