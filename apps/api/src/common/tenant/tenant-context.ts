import { AsyncLocalStorage } from 'node:async_hooks';
import { DomainError } from '@deehub/shared';

/**
 * Ambient tenant scope for the current request (ADR-0001, architecture.md §3).
 *
 * The repository layer reads this on every query. Because `requireTenant()`
 * throws when no scope is active, a query that forgets its tenant filter fails
 * loudly in development instead of quietly returning another hotel's
 * reservations in production. Cross-tenant isolation becomes a structural
 * property rather than a code-review responsibility.
 */

export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string | null;
  /** Set only for property-scoped requests. */
  readonly propertyId: string | null;
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active tenant scope, or null outside a request (jobs, boot, tests). */
export function getTenant(): TenantContext | null {
  return storage.getStore() ?? null;
}

/** The active tenant scope. Throws when there is none — never returns undefined. */
export function requireTenant(): TenantContext {
  const context = storage.getStore();
  if (!context) {
    throw new DomainError(
      'INTERNAL_ERROR',
      'No tenant context is active. Tenant-scoped work must run inside runWithTenant().',
    );
  }
  return context;
}

export function requireOrganizationId(): string {
  return requireTenant().organizationId;
}

/**
 * Property scope for the current request.
 *
 * Distinct from a missing tenant context: this means the caller reached
 * property-scoped code through a route that never resolved a property.
 */
export function requirePropertyId(): string {
  const context = requireTenant();
  if (!context.propertyId) {
    throw new DomainError('INTERNAL_ERROR', 'No property is in scope for this request');
  }
  return context.propertyId;
}
