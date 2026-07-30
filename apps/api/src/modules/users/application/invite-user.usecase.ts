import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { isUniqueViolation } from '../../../common/database/unique-violation';
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

/**
 * Readable rather than maximally dense: it gets read off a screen and typed
 * once. A password nobody can transcribe ends up on a sticky note.
 */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return [chars.slice(0, 5), chars.slice(5, 10), chars.slice(10, 15), chars.slice(15, 20)]
    .map((group) => group.join(''))
    .join('-');
}

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

    const password = generatePassword();
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
