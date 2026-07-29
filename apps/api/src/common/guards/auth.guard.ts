import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, errors } from '@deehub/shared';
import { AuthService } from '../../modules/auth/application/auth.service';
import type { UserPrincipal } from '../../modules/auth/domain/auth.repository';
import {
  canAccessProperty,
  effectiveCapabilities,
  type Capability,
} from '../../modules/auth/domain/capabilities';
import { setPropertyScope, setTenantScope } from '../tenant/tenant-context';

const PUBLIC_KEY = 'deehub:public';
const CAPABILITY_KEY = 'deehub:capability';

/** Marks a route as reachable without a token (login, health, webhooks). */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC_KEY, true);

/** Declares the capability a route requires. */
export const RequireCapability = (capability: Capability): CustomDecorator =>
  SetMetadata(CAPABILITY_KEY, capability);

export interface AuthenticatedRequest extends Request {
  principal?: UserPrincipal;
  capabilities?: ReadonlySet<Capability>;
}

/**
 * Authenticates the request, establishes the tenant scope, and enforces the
 * route's capability (architecture.md §3).
 *
 * One guard rather than three because the steps are strictly sequential and
 * share expensive work: the principal loaded to authenticate is the same one
 * whose memberships decide property access and capabilities.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearer(request);
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Missing bearer token');

    const principal = await this.auth.authenticate(token);

    // Populates the AsyncLocalStorage scope opened by RequestScopeMiddleware.
    // Everything downstream — including every repository — reads the tenant
    // from here and can no longer run unscoped.
    setTenantScope(principal.organizationId, principal.id);

    const propertyId = this.extractPropertyId(request);
    if (propertyId) {
      // Not FORBIDDEN: confirming the property exists in another organization
      // would be an existence oracle (api-spec.md §4).
      if (!canAccessProperty(principal.memberships, propertyId)) {
        throw errors.notFound('Property', propertyId);
      }
      setPropertyScope(propertyId);
    }

    const capabilities = effectiveCapabilities(principal.memberships, propertyId ?? null);
    request.principal = principal;
    request.capabilities = capabilities;

    const required = this.reflector.getAllAndOverride<Capability>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !capabilities.has(required)) {
      throw errors.forbidden(required);
    }

    return true;
  }

  private extractBearer(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }

  /** Property-scoped routes are nested under /properties/:propertyId. */
  private extractPropertyId(request: Request): string | null {
    const params = request.params as Record<string, string | undefined>;
    return params['propertyId'] ?? null;
  }
}
