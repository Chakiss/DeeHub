# ADR-0001: Multi-property SaaS from day one

- **Status:** Accepted
- **Date:** 2026-07-29
- **Decider:** Founder

## Context

DeeHub could be built as a system for a single hotel first, or as a
multi-tenant SaaS platform where many hotels sign up. The product vision
(PMS + Channel Manager + Booking Engine sold to hotels) is inherently
multi-tenant, but tenancy adds upfront complexity.

## Decision

Design for multi-property SaaS from the start:

- Tenancy hierarchy: **Organization → Property → (everything else)**.
- Shared database, shared schema; every business table carries an
  `organization_id` (and `property_id` where applicable).
- All queries are organization-scoped at the repository layer; no query may
  run without a tenant scope. Enforced by a mandatory tenant context in the
  request pipeline.
- Users belong to an organization; roles can be organization-wide or
  per-property.

## Consequences

- Slightly more upfront work (tenant context, scoping guards, tests for
  isolation).
- Avoids the notoriously painful retrofit of tenancy into a single-tenant
  data model.
- Cross-tenant data leakage becomes the top security risk — every feature's
  security review must verify tenant isolation (see Definition of Done).
- Postgres Row-Level Security can be layered on later as defense in depth
  without schema changes.
