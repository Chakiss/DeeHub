import { errors } from '@deehub/shared';
import { outranksOrEquals, type Role } from '../../auth/domain/capabilities';

/**
 * Rules that capabilities cannot express.
 *
 * A capability answers "may this person administer users at all". It cannot
 * answer "may this ADMIN create an OWNER", because both are the same
 * `user:invite` check. These three keep an organization from handing away more
 * authority than the actor holds, or from locking itself out entirely.
 */

/** The senior-most role the actor holds anywhere in the organization. */
export function highestRole(
  memberships: readonly { role: Role; propertyId: string | null }[],
): Role | null {
  let best: Role | null = null;
  for (const membership of memberships) {
    if (best === null || outranksOrEquals(membership.role, best)) best = membership.role;
  }
  return best;
}

/**
 * Nobody may grant a role more senior than their own.
 *
 * Without this an ADMIN — who legitimately holds `user:invite` — could mint an
 * OWNER and then be administered by the account they just created.
 */
export function assertMayGrant(actorRole: Role | null, targetRole: Role): void {
  if (actorRole === null || !outranksOrEquals(actorRole, targetRole)) {
    throw errors.forbidden('user:manage-roles');
  }
}

/**
 * Nobody may act on someone more senior than themselves.
 *
 * Otherwise an ADMIN could disable the OWNER and take over the organization.
 */
export function assertMayAdminister(actorRole: Role | null, targetRole: Role | null): void {
  if (actorRole === null) throw errors.forbidden('user:update');
  if (targetRole !== null && !outranksOrEquals(actorRole, targetRole)) {
    throw errors.forbidden('user:manage-roles');
  }
}

/**
 * An organization must keep at least one active owner.
 *
 * Defence in depth, and deliberately kept even though no request can reach it
 * today: `assertMayAdminister` means only an owner may modify an owner, and
 * `assertNotSelf` means it cannot be the same one — so a second active owner
 * always exists by the time this runs. It stays because it is the rule that
 * actually matters, and the two guards that currently imply it are about
 * seniority and self-harm, not about the organization keeping an administrator.
 * If either is ever relaxed — an owner stepping down, say — this is what stops
 * the last one disappearing, with no support tooling to undo it.
 *
 * Covered by unit tests rather than an HTTP case, because an HTTP case would
 * pass whether or not this function did anything.
 */
export function assertNotLastOwner(otherActiveOwners: number): void {
  if (otherActiveOwners === 0) {
    throw errors.validation(
      'This is the only active owner. Appoint another owner before changing this account.',
    );
  }
}

/** Locking yourself out is always a mistake, never an intent. */
export function assertNotSelf(actorUserId: string | null, targetUserId: string): void {
  if (actorUserId !== null && actorUserId === targetUserId) {
    throw errors.validation('You cannot change your own role or status');
  }
}
