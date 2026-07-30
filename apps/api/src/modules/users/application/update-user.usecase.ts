import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Role } from '../../auth/domain/capabilities';
import {
  USER_REPOSITORY,
  type OrganizationUser,
  type UserRepository,
} from '../domain/user.repository';
import {
  assertMayAdminister,
  assertMayGrant,
  assertNotLastOwner,
  assertNotSelf,
  highestRole,
} from './user.rules';

export interface UpdateUserInput {
  readonly userId: string;
  readonly fullName?: string;
  readonly role?: Role;
  readonly status?: 'ACTIVE' | 'DISABLED';
  readonly actorUserId: string | null;
  readonly actorRole: Role | null;
}

/**
 * Change a colleague's name, role or status.
 *
 * There is no delete. A user is referenced by every audit entry and every
 * reservation they touched, so removing the row would detach that history from
 * whoever did it. DISABLED stops them signing in and keeps the record.
 */
@Injectable()
export class UpdateUserUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UpdateUserInput, actor: AuditActor): Promise<OrganizationUser> {
    const organizationId = requireOrganizationId();

    const before = await this.repo.findById(this.db, input.userId);
    if (!before) throw errors.notFound('User', input.userId);

    const changesAuthority = input.role !== undefined || input.status !== undefined;
    if (changesAuthority) {
      // Renaming yourself is fine; changing your own role or status is how an
      // organization loses its last administrator by accident.
      assertNotSelf(input.actorUserId, input.userId);
    }

    const targetRole = highestRole(before.memberships);
    assertMayAdminister(input.actorRole, targetRole);
    if (input.role !== undefined) assertMayGrant(input.actorRole, input.role);

    // Demoting the last owner, or disabling them, leaves nobody able to appoint
    // another — and there is no support tooling to undo it.
    const losesOwnership =
      (input.role !== undefined && input.role !== 'OWNER' && targetRole === 'OWNER') ||
      (input.status === 'DISABLED' && targetRole === 'OWNER');
    if (losesOwnership) {
      assertNotLastOwner(await this.repo.countOtherActiveOwners(this.db, input.userId));
    }

    if (input.fullName === undefined && input.role === undefined && input.status === undefined) {
      throw errors.validation('No fields to update');
    }

    return this.db.transaction(async (tx) => {
      if (input.fullName !== undefined || input.status !== undefined) {
        await this.repo.updateProfile(tx, input.userId, {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        });
      }
      if (input.role !== undefined) {
        await this.repo.setOrganizationRole(tx, organizationId, input.userId, input.role);
      }

      const after = await this.repo.findById(tx, input.userId);
      if (!after) {
        throw new DomainError('INTERNAL_ERROR', 'User could not be read back after update');
      }

      await this.audit.record(tx, {
        organizationId,
        propertyId: null,
        actor,
        action:
          input.status === 'DISABLED'
            ? 'user.disabled'
            : input.role !== undefined
              ? 'user.role_changed'
              : 'user.updated',
        entityType: 'user',
        entityId: input.userId,
        before: { ...before, memberships: [...before.memberships] },
        after: { ...after, memberships: [...after.memberships] },
      });

      return after;
    });
  }
}
