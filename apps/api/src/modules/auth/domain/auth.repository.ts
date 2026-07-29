import type { Executor } from '../../../database/executor';
import type { Membership, Role } from './capabilities';

export interface AuthUser {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly passwordHash: string;
}

export interface UserPrincipal {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly fullName: string;
  readonly memberships: readonly Membership[];
}

export interface StoredRefreshToken {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Auth persistence port.
 *
 * Deliberately NOT organization-scoped: login happens before any tenant scope
 * exists, so these are the only reads in the system allowed to run unscoped.
 * They compensate by keying on values the caller cannot forge — an email plus
 * organization slug, or a token hash.
 */
export interface AuthRepository {
  findUserForLogin(tx: Executor, orgSlug: string, email: string): Promise<AuthUser | null>;
  findPrincipalById(tx: Executor, userId: string): Promise<UserPrincipal | null>;
  updatePasswordHash(tx: Executor, userId: string, passwordHash: string): Promise<void>;
  recordLogin(tx: Executor, userId: string, at: Date): Promise<void>;

  insertRefreshToken(
    tx: Executor,
    token: {
      id: string;
      organizationId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent: string | null;
      ip: string | null;
    },
  ): Promise<void>;

  findRefreshTokenByHash(tx: Executor, tokenHash: string): Promise<StoredRefreshToken | null>;

  /** Mark a token used and point it at its successor (rotation chain). */
  rotateRefreshToken(tx: Executor, tokenId: string, replacedById: string): Promise<void>;

  revokeRefreshToken(tx: Executor, tokenId: string): Promise<void>;

  /** Revoke every live token for a user, after detected reuse. */
  revokeAllForUser(tx: Executor, userId: string): Promise<number>;

  findMemberships(
    tx: Executor,
    userId: string,
  ): Promise<readonly { role: Role; propertyId: string | null }[]>;
}

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');
