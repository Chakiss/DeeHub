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
 *
 * Lifecycle: middleware opens an EMPTY scope for the request, then the auth
 * guard populates it once the token is verified. It has to work this way —
 * a guard returns a boolean and cannot wrap the handler in
 * `AsyncLocalStorage.run()`, so the store object must already exist and be
 * mutated in place. Until the guard fills it, `requireTenant()` still throws,
 * so an unauthenticated code path cannot read data.
 */

export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string | null;
  /** Set only for property-scoped requests. */
  readonly propertyId: string | null;
  readonly requestId: string;
}

interface MutableScope {
  organizationId: string | null;
  userId: string | null;
  propertyId: string | null;
  requestId: string;
}

const storage = new AsyncLocalStorage<MutableScope>();

/** Open an empty request scope. Called by middleware, before authentication. */
export function runWithRequestScope<T>(requestId: string, fn: () => T): T {
  return storage.run({ organizationId: null, userId: null, propertyId: null, requestId }, fn);
}

/** Run with a fully known scope. Used by jobs, the outbox relay and tests. */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  return storage.run(
    {
      organizationId: context.organizationId,
      userId: context.userId,
      propertyId: context.propertyId,
      requestId: context.requestId,
    },
    fn,
  );
}

/** Populate the scope after the token is verified. */
export function setTenantScope(organizationId: string, userId: string | null): void {
  const scope = storage.getStore();
  if (!scope) {
    throw new DomainError(
      'INTERNAL_ERROR',
      'Cannot set a tenant scope outside a request scope. Is RequestScopeMiddleware registered?',
    );
  }
  scope.organizationId = organizationId;
  scope.userId = userId;
}

/** Record the property a property-scoped route is operating on. */
export function setPropertyScope(propertyId: string | null): void {
  const scope = storage.getStore();
  if (scope) scope.propertyId = propertyId;
}

export function getRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/** The active tenant scope, or null when unauthenticated or outside a request. */
export function getTenant(): TenantContext | null {
  const scope = storage.getStore();
  if (!scope?.organizationId) return null;
  return {
    organizationId: scope.organizationId,
    userId: scope.userId,
    propertyId: scope.propertyId,
    requestId: scope.requestId,
  };
}

/** The active tenant scope. Throws when there is none — never returns undefined. */
export function requireTenant(): TenantContext {
  const context = getTenant();
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
