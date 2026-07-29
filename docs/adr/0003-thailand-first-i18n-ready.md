# ADR-0003: Thailand-first, i18n-ready

- **Status:** Accepted
- **Date:** 2026-07-29
- **Decider:** Founder

## Context

The first market is Thailand, but hardcoding THB and Thai conventions would
make every money field and screen a retrofit if DeeHub expands. Full
multi-currency with exchange rates is out of scope for the 90-day milestone.

## Decision

- **Money:** every monetary value is stored as `(amount, currency)` —
  integer minor units + ISO 4217 code. Each property has a base currency
  (default `THB`). No cross-currency conversion in v1.
- **Dates:** a hotel night is a **calendar date in the property's timezone**
  (`DATE` column), never a UTC timestamp. Property timezone defaults to
  `Asia/Bangkok`. Event timestamps (audit, sync) are UTC `timestamptz`.
- **Language:** admin UI in English first; `next-intl` wired from day one so
  Thai translation is a locale file, not a refactor. No user-facing strings
  hardcoded in components.
- **Tax:** Thai VAT (7%) and service charge (10%) modeled as configurable
  per-property tax/fee settings, not constants.

## Consequences

- Money arithmetic uses a shared `Money` value object (no floats, ever).
- Date handling bugs (the classic off-by-one-night around midnight/UTC) are
  prevented structurally.
- Adding a second market later means translations + tax settings, not a
  schema migration.
