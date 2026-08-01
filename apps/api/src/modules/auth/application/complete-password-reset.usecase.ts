import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService } from '../../../common/audit/audit.service';
import { AUTH_REPOSITORY, type AuthRepository } from '../domain/auth.repository';
import { PASSWORD_HASHER, type PasswordHasher } from '../domain/password-hasher';
import {
  PASSWORD_RESET_REPOSITORY,
  classifyResetToken,
  hashResetToken,
  type PasswordResetRepository,
} from '../domain/password-reset';

export interface CompletePasswordResetInput {
  readonly token: string;
  readonly newPassword: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface CompletePasswordResetResult {
  /** So the dashboard can prefill the sign-in form it sends the person to. */
  readonly organizationSlug: string;
  readonly email: string;
}

/**
 * Spend a reset link and set a new password (api-spec.md §3).
 *
 * **No session is issued.** Completing this leaves the person at the sign-in
 * screen with the password they just chose. Handing out tokens would turn a
 * link sitting in a mailbox into a session, and the one thing that makes an
 * emailed link acceptable as a credential is that it is single-use, short
 * lived, and only good for the one action the person expected.
 *
 * Everything else the account had is revoked. The usual reason a password is
 * being reset is that somebody else may hold the old one, and a thirty-day
 * refresh token would hand the account straight back.
 */
@Injectable()
export class CompletePasswordResetUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_REPOSITORY) private readonly auth: AuthRepository,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly tokens: PasswordResetRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CompletePasswordResetInput): Promise<CompletePasswordResetResult> {
    const now = new Date();
    const stored = await this.tokens.findByHash(this.db, hashResetToken(input.token));
    const { state } = classifyResetToken(stored, now);

    // One message for unknown, expired and already-spent. The differences are
    // not actionable to the person, and telling an unauthenticated caller that
    // a token once existed is an oracle bought for nothing.
    if (state !== 'VALID' || !stored) throw this.invalidLink();

    const user = await this.auth.findAuthUserById(this.db, stored.userId);
    // Disabled between the request and the click, or the organization was
    // suspended. Either way this link no longer opens anything.
    if (!user) throw this.invalidLink();

    if (await this.hasher.verify(input.newPassword, user.passwordHash)) {
      /*
       * Refused, and this is not pedantry. Somebody who can still supply the
       * current password is not locked out, so the likely case is a person
       * working through a reset they did not ask for — which is exactly when
       * a no-op that reports success is the wrong answer.
       */
      throw new DomainError(
        'VALIDATION_ERROR',
        'The new password must differ from your current one',
      );
    }

    const passwordHash = await this.hasher.hash(input.newPassword);

    await this.db.transaction(async (tx) => {
      // The database decides who wins a race between two clicks on the same
      // link; the loser must not go on to set a password.
      const consumed = await this.tokens.consume(tx, stored.id, now);
      if (!consumed) throw this.invalidLink();

      await this.auth.updatePasswordHash(tx, user.id, passwordHash);

      const sessionsRevoked = await this.auth.revokeAllForUser(tx, user.id);
      // Any other link that was in flight dies here too. Leaving one alive
      // would let whoever triggered the earlier request in afterwards.
      const linksInvalidated = await this.tokens.invalidateLiveForUser(tx, user.id, now, stored.id);

      await this.audit.record(tx, {
        organizationId: user.organizationId,
        propertyId: null,
        actor: {
          type: 'USER',
          id: user.id,
          label: user.email,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
        action: 'auth.password_reset_completed',
        entityType: 'user',
        entityId: user.id,
        after: { sessionsRevoked, linksInvalidated },
      });
    });

    const slug = await this.auth.findOrganizationSlug(this.db, user.organizationId);
    return { organizationSlug: slug ?? '', email: user.email };
  }

  private invalidLink(): DomainError {
    return new DomainError(
      'UNAUTHENTICATED',
      'This reset link is no longer valid. Request a new one.',
    );
  }
}
