import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { generateTemporaryPassword } from '../../../common/security/temporary-password';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { AUTH_REPOSITORY, type AuthRepository } from '../../auth/domain/auth.repository';
import { PASSWORD_HASHER, type PasswordHasher } from '../../auth/domain/password-hasher';
import type { Role } from '../../auth/domain/capabilities';
import { USER_REPOSITORY, type UserRepository } from '../domain/user.repository';
import { assertMayAdminister, highestRole } from './user.rules';

export interface ResetPasswordInput {
  readonly userId: string;
  readonly actorUserId: string | null;
  readonly actorRole: Role | null;
}

export interface ResetPasswordResult {
  readonly email: string;
  readonly fullName: string;
  /** Shown to the operator once. Never stored, never in the audit entry. */
  readonly temporaryPassword: string;
}

/**
 * Reset a colleague's password when they cannot sign in.
 *
 * This is the whole recovery story today. Self-service `forgot-password`
 * requires sending mail, and there is no mail provider — an endpoint that
 * returned 202 and sent nothing would be worse than not having one, because
 * the person would sit waiting for an email that never arrives.
 *
 * Every session the account had is revoked. If the reason for the reset is
 * that someone else got into the account, leaving their refresh token alive
 * would hand it straight back.
 */
@Injectable()
export class ResetPasswordUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    @Inject(AUTH_REPOSITORY) private readonly auth: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ResetPasswordInput, actor: AuditActor): Promise<ResetPasswordResult> {
    const organizationId = requireOrganizationId();

    const target = await this.repo.findById(this.db, input.userId);
    if (!target) throw errors.notFound('User', input.userId);

    /**
     * Never on yourself, and this is a security rule rather than a nicety.
     *
     * Changing your own password goes through /auth/change-password, which
     * demands the CURRENT one. If this endpoint accepted self, a stolen access
     * token would be enough to set a new password and lock the real owner out
     * of their own hotel — exactly what that check exists to prevent.
     */
    if (input.actorUserId !== null && input.actorUserId === input.userId) {
      throw errors.validation(
        'Use change password for your own account, which requires your current password',
      );
    }

    // An ADMIN resetting the OWNER's password would be a takeover.
    assertMayAdminister(input.actorRole, highestRole(target.memberships));

    const password = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(password);

    await this.db.transaction(async (tx) => {
      await this.auth.updatePasswordHash(tx, input.userId, passwordHash);

      // Before returning, not after: the point of a reset is that whoever had
      // the old credential stops having access.
      const revoked = await this.auth.revokeAllForUser(tx, input.userId);

      await this.audit.record(tx, {
        organizationId,
        propertyId: null,
        actor,
        action: 'user.password_reset',
        entityType: 'user',
        entityId: input.userId,
        // The count, never the password.
        after: { sessionsRevoked: revoked },
      });
    });

    return {
      email: target.email,
      fullName: target.fullName,
      temporaryPassword: password,
    };
  }
}
