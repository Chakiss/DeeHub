# Accounting — revenue, expenses, and the Thai tax paperwork

> Design artifact per `CLAUDE.md`. Decisions and their reasoning are in
> [ADR-0008](adr/0008-accounting-ledger.md); this is the build.
>
> Phase 1 of four. Phases 2–4 are sketched in §7 and will each get their own
> pass through this template rather than being designed in advance here.

## 1. Business Goal

The owner's question is _what did I make this month_, and the system can only
answer half of it. Revenue is here — frozen night prices, folio extras,
payments, ADR and RevPAR. **The expense side does not exist**: no vendors, no
categories, no purchase invoices, no withholding tax, not one row. So the owner
exports bookings to a spreadsheet, types in the electricity bill from a photo
on their phone, and arrives at a profit figure nobody can audit.

Phase 1 makes the profit figure come out of the system, and produces
**รายงานเงินสดรับ-จ่าย** — which is not a convenience report but the book the
Revenue Department requires an individual taxpayer with 40(8) income to keep.

## 2. Functional Requirements

1. Record a hotel's taxpayer identity per property: individual or juristic,
   tax ID with branch code, VAT registered or not, legal name and address.
2. Seed a Thai hotel's expense categories on property creation, each carrying
   the withholding rate that normally applies to it.
3. Record a vendor once, including whether they are an individual or a company
   (which decides ภ.ง.ด.3 vs ภ.ง.ด.53) and whether they are foreign (which is
   what will later trigger ภ.พ.36).
4. Record an expense from the total on the receipt: the system splits VAT out,
   suggests the withholding rate from the category, and shows what is actually
   paid to the vendor versus remitted to the Revenue Department.
5. Record income that did not come from a booking.
6. Refuse a supplier invoice number already recorded for that vendor.
7. Void an expense with a reason. Never delete one.
8. Report: monthly summary, รายงานเงินสดรับ-จ่าย, and a profit and loss on
   either basis with revenue derived live from bookings.
9. Export any report as CSV that opens correctly in Thai in Excel.
10. A manager can record expenses without being able to see profit or tax data.

**Deliberately not in phase 1:** period close, revenue postings, tax documents,
withholding certificates, ภ.พ.30, PDF, receipt photo attachments (the project
has no object storage — phase 1 stores a text reference), Excel, a full cash
flow statement.

## 3. Non-functional Requirements

- Money is `bigint` minor units and `char(3)` currency throughout; rates are
  basis points. No floats, no decimals, no cross-currency arithmetic (ADR-0003).
- Business dates are `date` in the property's timezone, from
  `businessDate(tz)` — never `new Date()` on the server.
- Every table carries `organization_id`; every repository query filters on
  `requireOrganizationId()`. A cross-tenant miss is 404, not 403.
- Every mutation writes an audit log inside the same transaction.
- VAT and service-charge arithmetic reuses `computeBreakdown()` and the shared
  `Money` kernel. No second implementation of Thai tax composition exists.
- The VAT rate is read from the property, never hardcoded — 7% is a
  periodically renewed reduction from a statutory 10%.

## 4. Database Design

Six tables in `apps/api/src/database/schema/accounting.ts`, migration `0012`.

### `accounting_settings` — one row per property

The taxpayer is not the property. Several properties under one tax ID are
_branches_ differing only by `branch_code`, which this shape handles, and a
property can exist before anyone has decided how it is taxed.

`property_id` PK · `taxpayer_type INDIVIDUAL|JURISTIC` · `tax_id` ·
`branch_code` (`'00000'` = สำนักงานใหญ่) · `legal_name_th` · `legal_name_en` ·
`address_th` · `vat_registered` · `vat_registered_from` · `wht_enabled` ·
`local_levy_enabled` + `local_levy_rate_bp` (ค่าธรรมเนียมบำรุง อบจ., off by
default — the rate is set by each province's ordinance) ·
`fiscal_year_start_month`.

`taxpayer_type` selects which basis the income-tax reports use. An individual
files on cash (ภ.ง.ด.90/94), a juristic person on accrual (ภ.ง.ด.50/51). It is
a fact about the taxpayer, not a preference.

### `expense_categories` — seeded, per property

`code` · `name_th` · `name_en` · `group` · `default_wht_rate_bp` ·
`default_wht_income_type` · `is_deductible` · `sort_order` · `is_active`.

`group` is the profit-and-loss line: `COGS`, `PAYROLL`, `UTILITIES`,
`OPERATIONS`, `MARKETING`, `ADMIN`, `FINANCE`, `TAX`, `OTHER`.

`default_wht_rate_bp` is the whole ease-of-use argument in one column: rent
5%, hire-of-work and services 3%, professional fees 3%, advertising 2%,
transport 1%, non-life insurance 1%. The owner picks "ค่าซ่อมบำรุง" and the
withholding is proposed rather than looked up.

### `vendors`

`name` · `tax_id` · `branch_code` · `taxpayer_type` · `country` ·
`is_foreign` · `address` · `phone` · `default_category_id` ·
`default_wht_rate_bp` · `is_active` · unique on `(property_id, lower(name))`.

`is_foreign` earns its place in phase 1 despite being unused until phase 4:
commission paid to Agoda or Booking.com is a service performed abroad and used
in Thailand, so a VAT-registered hotel must self-assess 7% VAT on ภ.พ.36. It is
cheaper to capture the flag while the vendor is being created than to ask an
owner to revisit two years of invoices later.

### `expenses`

`kind EXPENSE|VENDOR_CREDIT_NOTE` — a vendor's credit note is its own positive
row, not a negative expense, for the reason `folio_payments` gives about
refunds: a net figure hides both sides and the person reconciling needs them
apart.

Money: `net_amount_minor` · `vat_minor` (input tax the supplier charged) ·
`self_assessed_vat_minor` (ภ.พ.36 — a different tax, so a different column) ·
`vat_claimable` · `gross_amount_minor` · `wht_rate_bp` · `wht_minor` ·
`paid_amount_minor`.

Dates: `expense_date` (accrual — the date on the supplier's invoice) ·
`paid_date` (cash, null while unpaid, which is how a payable is represented) ·
`payment_method`.

`vat_claimed_period` (`YYYY-MM`) is separate from `expense_date` because input
tax may be claimed in the invoice's month or within the six months after, and
an invoice arriving late is the normal case for a small hotel, not an edge one.
Without this column a ภ.พ.30 worksheet cannot defer anything.

Supplier document: `supplier_doc_number` · `supplier_doc_date` ·
`supplier_doc_type`. Plus `attachment_ref`, `note`, `status`, void columns,
`recorded_by_user_id`.

Constraints, which are where the correctness actually lives:

```
gross_amount_minor = net_amount_minor + vat_minor
paid_amount_minor  = gross_amount_minor - wht_minor
gross_amount_minor > 0
(voided_at IS NULL) = (voided_reason IS NULL)
(paid_date IS NULL) = (payment_method IS NULL)
```

and the duplicate guard, the cheapest correctness win in the schema:

```sql
UNIQUE (property_id, vendor_id, supplier_doc_number)
  WHERE supplier_doc_number IS NOT NULL AND voided_at IS NULL
```

Indexes on `(property_id, expense_date)`, `(property_id, paid_date)`,
`(property_id, category_id, expense_date)`, `(vendor_id, expense_date)`,
`(property_id, vat_claimed_period)`.

### `expense_recurrences`

`category_id` · `vendor_id` · `day_of_month` · `expected_amount_minor` ·
`is_active`. This is a completeness mechanism, not a convenience: it is what
lets the month-end checklist say _"ยังไม่ได้บันทึก: ค่าไฟ"_. A missing expense
is invisible by nature — nothing prompts you to notice a row that isn't there.

### `revenue_entries`

Income that is not a booking: shop rent, souvenir sales, a cancellation fee
billed outside a reservation. Same shape mirrored, plus `wht_withheld_minor`
for tax a corporate customer withheld from us.

That last column needs a warning in the UI rather than a plain label. Under
ท.ป.4/2528 hotel accommodation and restaurant service are **exempt** from the
3% withholding, so a corporate guest should not be withholding on a room bill.
It is legitimately non-zero when a meeting room is let as bare space, which is
rent at 5% — as opposed to a seminar package with food and service, which is
hotel service and exempt. Presented as an ordinary field, owners will accept
short payments they should be disputing.

**Rollback for `0012`:** every table is new and nothing references them, so the
down path is `DROP TABLE` in reverse dependency order (`revenue_entries`,
`expense_recurrences`, `expenses`, `vendors`, `expense_categories`,
`accounting_settings`). No existing table is altered, so a rollback loses only
accounting data entered since deploy — recover from PITR if that matters.

## 5. API Design

Per `api-spec.md` §2. Money as `{amount, currency}`, dates as `YYYY-MM-DD` in
property time, `from` inclusive and `to` exclusive, collections wrapped,
`Idempotency-Key` on every POST.

```
GET  PUT   /properties/:id/accounting/settings
GET  POST  /properties/:id/accounting/categories
GET  POST  /properties/:id/accounting/vendors
GET  POST  /properties/:id/accounting/expenses
POST       /properties/:id/accounting/expenses/:eid/void
GET  POST  /properties/:id/accounting/revenue-entries
GET        /properties/:id/accounting/summary?year&month
GET        /properties/:id/accounting/reports/cash-book?from&to
GET        /properties/:id/accounting/reports/profit-loss?from&to&basis
```

New error codes: `PERIOD_CLOSED` (409, phase 2), `DUPLICATE_SUPPLIER_DOCUMENT`
(409), `VAT_CLAIM_WINDOW_EXPIRED` (422).

## 6. Capabilities

`capabilities.ts` computes the read-only bundle as every capability ending in
`:read`. That is a naming accident waiting to hand a receptionist the profit
and loss, and the file already flags it against `folio:read`. **Replace the
filter with an explicit list first** — enumerating today's exact set, so
behaviour does not change — then add:

| Capability                   | OWNER | ADMIN | MANAGER | FRONT_DESK | READ_ONLY |
| ---------------------------- | :---: | :---: | :-----: | :--------: | :-------: |
| `expense:read`               |   ●   |   ●   |    ●    |            |           |
| `expense:write`              |   ●   |   ●   |    ●    |            |           |
| `expense:void`               |   ●   |   ●   |         |            |           |
| `accounting:read` (P&L, tax) |   ●   |   ●   |         |            |           |
| `accounting:settings`        |   ●   |   ●   |         |            |           |

A manager runs the property and buys its electricity, so recording expenses is
their job. What the owner clears after costs, and the owner's tax ID, are not.

`tax_id` is not encrypted. It is printed on every invoice the business issues;
it is an identifier, not a secret. A 13-digit checksum check catches real
mistakes, which encryption would not.

## 7. Implementation Plan

**Phase 1 (this document).** Docs → capabilities refactor → schema + `0012` →
domain with unit tests → repository → use cases and queries → controller →
e2e → admin-web section → `database.md` and `api-spec.md`.

**Phase 2 — periods and posted revenue.** `accounting_periods`,
`revenue_postings` written idempotently from `maintenance.ts`, month close,
adjust-forward after close, and the drift reconciler. Profit and loss moves off
live derivation onto postings.

**Phase 3 — tax documents.** Credit and debit notes, gapless numbering, sales
and purchase VAT reports, ภ.พ.30 worksheet. Founder decisions now settled
(2026-08-15, recorded in
[accounting-questions-for-accountant.md](accounting-questions-for-accountant.md)):

- **Numbering is `YYYYMMDDNNN`, reset daily** — `20260801001` is the first
  document of 1 August. Not the yearly sequence this plan first assumed, so the
  sequence key is the date rather than the year.
- **A refundable security deposit carries no VAT and gets no tax invoice.** It
  is a different kind of receipt from a room deposit, which is payment against a
  price, and the two need separating at the point money is taken.
- **Full-form invoices only**, when the property is VAT registered.
- **Delivery is by email.** This needs the e-Tax Invoice by Email registration
  to stand up legally — see the risk below — so phase 3 builds the print view
  as well and does not present an emailed file as the original until that
  registration is confirmed.
- **Issued after the stay ends and is paid in full, in the following month.**
  This is the hotel's practice and is implemented as the default workflow, but
  it is NOT confirmed against มาตรา 78/1: if the tax point is receipt of
  payment, a deposit taken in October and invoiced in January is three months
  late. The two open questions above are gating for this phase.

**Phase 4 — withholding and foreign vendors.** 50 ทวิ, ภ.ง.ด.3/53, ภ.พ.36,
half-year aggregation for ภ.ง.ด.94/51, provincial levy report.

## 8. Test Cases

**Unit** — splitting VAT out of a gross amount and adding it back returns the
original for every amount; withholding at each rate, including the 1,000 THB
per-contract exemption; the two amount identities hold for every generated
input; profit and loss excludes VAT from revenue and includes service charge;
a 13-digit tax ID checksum accepts real IDs and rejects transpositions;
category groups map to exactly one P&L line each.

**Integration** — an expense and its audit row commit or roll back together; a
duplicate supplier invoice number is rejected by the index, not by a race-prone
pre-check; a voided expense leaves the number free again; tenant scope is
enforced on read, update and void; the cash book totals match the sum of its
rows.

**E2E** — the capability matrix, especially a MANAGER who can POST an expense
and gets 403 on profit and loss; a cross-organization property returns 404; a
month of expenses reconciles against the summary endpoint.

## 9. Risks

| Risk                                        | If it happens                                      | Mitigation                                                                                                  |
| ------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A tax report is wrong                       | The hotel is assessed and penalised                | Every report is labelled a worksheet; DeeHub never files; an accountant reviews the formulas before phase 3 |
| VAT counted as revenue                      | Profit overstated 7% every month                   | Dedicated unit test; the P&L function takes the breakdown apart explicitly                                  |
| Withholding shown as normal on room revenue | Owner accepts short payments they should dispute   | The field carries the ท.ป.4/2528 exemption in its help text, not just a label                               |
| `accounting:read` reaches READ_ONLY         | Staff see the owner's profit and tax ID            | Explicit read-only list lands _before_ the new capabilities                                                 |
| Duplicate expense entry                     | Costs double, profit understated, VAT over-claimed | Partial unique index on the supplier document number                                                        |
| Scope exceeds a one-person team             | Nothing ships                                      | Four phases, each useful alone; phase 1 needs no tax decisions                                              |

## 10. Future Improvements

Receipt photos once object storage exists · a double-entry projection over
these rows for an accountant who wants one · OTA commission pre-filled from
`channel_rate_plan_mappings` once per-channel commission is modelled, as a
suggestion to reconcile against the statement rather than an auto-posted
expense · bank statement matching · fixed assets and depreciation · a cash-flow
forecast from confirmed arrivals · the AI assistant answering _"ทำไมค่าไฟเดือนนี้
สูงกว่าปีที่แล้ว"_.
