import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { ENV, type Env } from '../../../config/env';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
  type UserPrincipal,
} from '../domain/auth.repository';
import { PASSWORD_HASHER, type PasswordHasher } from '../domain/password-hasher';
import { PASSWORD_RESET_REPOSITORY, type PasswordResetRepository } from '../domain/password-reset';

export interface LoginInput {
  readonly organizationSlug: string;
  readonly email: string;
  readonly password: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

export interface ChangePasswordInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export interface LoginResult extends AuthTokens {
  readonly user: UserPrincipal;
}

interface AccessTokenClaims {
  sub: string;
  orgId: string;
  jti: string;
}

/**
 * Authentication (api-spec.md §3).
 *
 * Two decisions worth knowing:
 *
 * 1. **Access tokens carry no roles.** Only `sub`, `orgId`, `jti`. Permissions
 *    are loaded per request, so revoking access takes effect immediately
 *    instead of when a 15-minute token happens to expire.
 * 2. **Refresh tokens rotate and are hashed at rest.** Presenting a token that
 *    was already used means it leaked, so the entire chain for that user is
 *    revoked rather than just refusing the request.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly resetTokens: PasswordResetRepository,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.repo.findUserForLogin(this.db, input.organizationSlug, input.email);

    // Verify a dummy hash when the user is absent so a missing account and a
    // wrong password take the same time. Skipping the work here is a textbook
    // user-enumeration oracle.
    if (!user) {
      await this.hasher.verify(input.password, await this.dummyHash());
      throw this.invalidCredentials();
    }

    const valid = await this.hasher.verify(input.password, user.passwordHash);
    if (!valid) throw this.invalidCredentials();

    // Same message for a disabled account: whether an account exists is not
    // something an unauthenticated caller should be able to learn.
    if (user.status !== 'ACTIVE') throw this.invalidCredentials();

    const principal = await this.repo.findPrincipalById(this.db, user.id);
    if (!principal) throw this.invalidCredentials();

    return this.db.transaction(async (tx) => {
      // Transparent upgrade when hashing parameters have been raised.
      if (this.hasher.needsRehash(user.passwordHash)) {
        await this.repo.updatePasswordHash(tx, user.id, await this.hasher.hash(input.password));
      }
      await this.repo.recordLogin(tx, user.id, new Date());

      const tokens = await this.issueTokens(tx, principal, input.userAgent, input.ip);

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        propertyId: null,
        actor: {
          type: 'USER',
          id: principal.id,
          label: principal.email,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
        action: 'auth.login',
        entityType: 'user',
        entityId: principal.id,
      });

      return { ...tokens, user: principal };
    });
  }

  /**
   * Change the caller's own password.
   *
   * Every other session is revoked, and that is the point rather than a side
   * effect. The reason a password gets changed is usually that it may have been
   * seen by someone else, so leaving already-issued refresh tokens alive would
   * defeat the change entirely — the holder of the old password would keep
   * access for up to thirty days without needing it again.
   *
   * The caller is kept signed in by issuing a fresh pair AFTER the revocation,
   * so the new tokens are not caught by it.
   */
  async changePassword(input: ChangePasswordInput): Promise<AuthTokens> {
    const user = await this.repo.findAuthUserById(this.db, input.userId);
    // The guard authenticated this request, so absence means the account was
    // disabled between issuing the token and using it.
    if (!user) throw new DomainError('UNAUTHENTICATED', 'Account is no longer active');

    // Re-verify the current password even though the caller holds a valid
    // session: it is what stops a stolen access token from locking the real
    // owner out of their own account.
    const valid = await this.hasher.verify(input.currentPassword, user.passwordHash);
    if (!valid) throw new DomainError('UNAUTHENTICATED', 'Current password is incorrect');

    if (input.currentPassword === input.newPassword) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'The new password must differ from the current one',
      );
    }

    const principal = await this.repo.findPrincipalById(this.db, user.id);
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Account is no longer active');

    const newHash = await this.hasher.hash(input.newPassword);

    return this.db.transaction(async (tx) => {
      await this.repo.updatePasswordHash(tx, user.id, newHash);

      // Before issuing the replacement pair, not after.
      const revoked = await this.repo.revokeAllForUser(tx, user.id);

      /*
       * And any reset link in flight. Someone who suspects their password was
       * seen changes it — but if the same someone had also triggered a reset,
       * or an attacker had, that link would still be live and would undo the
       * change an hour later. Revoking sessions without revoking links leaves
       * the door open behind you.
       */
      const linksInvalidated = await this.resetTokens.invalidateLiveForUser(
        tx,
        user.id,
        new Date(),
      );

      const tokens = await this.issueTokens(tx, principal, input.userAgent, input.ip);

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        propertyId: null,
        actor: {
          type: 'USER',
          id: principal.id,
          label: principal.email,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: principal.id,
        // Never the password, in any form. The counts are the part that
        // matters when reading this back during an incident.
        after: { sessionsRevoked: revoked, linksInvalidated },
      });

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      };
    });
  }

  async refresh(
    refreshToken: string,
    userAgent?: string | null,
    ip?: string | null,
  ): Promise<LoginResult> {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.repo.findRefreshTokenByHash(this.db, tokenHash);
    if (!stored) throw new DomainError('UNAUTHENTICATED', 'Invalid refresh token');

    if (stored.revokedAt) {
      // Reuse of a rotated token means it leaked. Kill every session for the
      // user: we cannot tell the attacker's copy from the victim's.
      const revoked = await this.db.transaction((tx) =>
        this.repo.revokeAllForUser(tx, stored.userId),
      );
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; revoked ${String(revoked)} tokens`,
      );
      throw new DomainError('UNAUTHENTICATED', 'Refresh token has already been used');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new DomainError('UNAUTHENTICATED', 'Refresh token has expired');
    }

    const principal = await this.repo.findPrincipalById(this.db, stored.userId);
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Account is no longer active');

    return this.db.transaction(async (tx) => {
      const tokens = await this.issueTokens(tx, principal, userAgent, ip);
      await this.repo.rotateRefreshToken(tx, stored.id, tokens.refreshTokenId);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user: principal,
      };
    });
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const stored = await this.repo.findRefreshTokenByHash(this.db, this.hashToken(refreshToken));
    // Idempotent: logging out twice, or with a stale token, is not an error.
    if (!stored || stored.revokedAt) return;
    await this.db.transaction((tx) => this.repo.revokeRefreshToken(tx, stored.id));
  }

  /** Verify an access token and load the current principal. */
  async authenticate(accessToken: string): Promise<UserPrincipal> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(accessToken, {
        secret: this.env.JWT_ACCESS_SECRET,
      });
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired access token');
    }

    const principal = await this.repo.findPrincipalById(this.db, claims.sub);
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Account is no longer active');

    // The token's organization must still match the user's. A mismatch means a
    // forged or stale token.
    if (principal.organizationId !== claims.orgId) {
      throw new DomainError('UNAUTHENTICATED', 'Token does not match the account organization');
    }

    return principal;
  }

  private async issueTokens(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    principal: UserPrincipal,
    userAgent?: string | null,
    ip?: string | null,
  ): Promise<AuthTokens & { refreshTokenId: string }> {
    const accessToken = await this.jwt.signAsync(
      { sub: principal.id, orgId: principal.organizationId, jti: newId() },
      { secret: this.env.JWT_ACCESS_SECRET, expiresIn: this.env.JWT_ACCESS_TTL },
    );

    // Refresh tokens are opaque random bytes, not JWTs: they are looked up in
    // the database anyway, so a self-describing token adds attack surface
    // without adding capability.
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshTokenId = newId();

    await this.repo.insertRefreshToken(tx, {
      id: refreshTokenId,
      organizationId: principal.organizationId,
      userId: principal.id,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL * 1000),
      userAgent: userAgent ?? null,
      ip: ip ?? null,
    });

    return {
      accessToken,
      refreshToken,
      refreshTokenId,
      expiresIn: this.env.JWT_ACCESS_TTL,
    };
  }

  /** SHA-256: the raw refresh token is never stored, so a DB leak is not a session leak. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private invalidCredentials(): DomainError {
    // One message for every failure mode: wrong password, unknown email,
    // disabled user, suspended organization.
    return new DomainError('UNAUTHENTICATED', 'Invalid email or password');
  }

  private dummyHashCache: string | null = null;

  private async dummyHash(): Promise<string> {
    this.dummyHashCache ??= await this.hasher.hash(randomBytes(16).toString('hex'));
    return this.dummyHashCache;
  }
}
