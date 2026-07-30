import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { isUniqueViolation } from '../../../common/database/unique-violation';
import { generateTemporaryPassword } from '../../../common/security/temporary-password';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { PASSWORD_HASHER, type PasswordHasher } from '../../auth/domain/password-hasher';
import type { Role } from '../../auth/domain/capabilities';
import {
  USER_REPOSITORY,
  type OrganizationUser,
  type UserRepository,
} from '../domain/user.repository';
import { assertMayGrant } from './user.rules';

export interface InviteUserInput {
  readonly email: string;
  readonly fullName: string;
  readonly role: Role;
  readonly actorRole: Role | null;
}

export interface InviteUserResult {
  readonly user: OrganizationUser;
  /**
   * Shown to the inviter ONCE and never stored in readable form.
   *
   * There is no outbound email yet, so the only way to hand over a credential
   * is to return it to the authenticated admin who asked for it, over TLS, and
   * have them relay it. It is deliberately absent from the audit entry.
   */
  readonly temporaryPassword: string;
}

const EMAIL_CONSTRAINT = 'users_org_email_uq';

@Injectable()
export class InviteUserUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
  ) {}

  async execute(input: InviteUserInput, actor: AuditActor): Promise<InviteUserResult> {
    const organizationId = requireOrganizationId();

    // Before any work: an ADMIN holds user:invite but must not be able to
    // create an OWNER.
    assertMayGrant(input.actorRole, input.role);

    const password = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(password);
    const id = newId();
    const email = input.email.trim().toLowerCase();

    try {
      const user = await this.db.transaction(async (tx) => {
        await this.repo.insert(tx, {
          id,
          organizationId,
          email,
          fullName: input.fullName.trim(),
          passwordHash,
        });
        await this.repo.setOrganizationRole(tx, organizationId, id, input.role);

        await this.audit.record(tx, {
          organizationId,
          propertyId: null,
          actor,
          action: 'user.invited',
          entityType: 'user',
          entityId: id,
          // Never the password, in any form.
          after: { email, fullName: input.fullName.trim(), role: input.role },
        });

        const created = await this.repo.findById(tx, id);
        if (!created) {
          throw new DomainError('INTERNAL_ERROR', 'User could not be read back after insert');
        }
        return created;
      });

      return { user, temporaryPassword: password };
    } catch (error) {
      if (isUniqueViolation(error, EMAIL_CONSTRAINT)) {
        throw errors.conflict(`${email} already has an account in this organization`, { email });
      }
      throw error;
    }
  }
}
