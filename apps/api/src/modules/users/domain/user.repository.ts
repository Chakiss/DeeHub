import type { Executor } from '../../../database/executor';
import type { Role } from '../../auth/domain/capabilities';

export interface OrganizationUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly lastLoginAt: Date | null;
  readonly memberships: readonly { role: Role; propertyId: string | null }[];
}

export interface CreateUserRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string;
}

/**
 * User administration within one organization.
 *
 * Scoped from the ambient tenant context (ADR-0001). Distinct from
 * AuthRepository, which reads unscoped because login happens before any tenant
 * exists — nothing here has that exemption.
 */
export interface UserRepository {
  list(tx: Executor): Promise<readonly OrganizationUser[]>;
  findById(tx: Executor, userId: string): Promise<OrganizationUser | null>;
  insert(tx: Executor, record: CreateUserRecord): Promise<void>;
  updateProfile(
    tx: Executor,
    userId: string,
    fields: { fullName?: string; status?: string },
  ): Promise<void>;

  /** Replaces the user's single organization-wide membership. */
  setOrganizationRole(
    tx: Executor,
    organizationId: string,
    userId: string,
    role: Role,
  ): Promise<void>;

  /**
   * Active owners other than `excludingUserId`.
   *
   * The guard against locking an organization out of itself: demoting or
   * disabling the last owner leaves nobody who can appoint another.
   */
  countOtherActiveOwners(tx: Executor, excludingUserId: string): Promise<number>;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
