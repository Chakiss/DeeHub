import { getTranslations } from 'next-intl/server';
import { ApiError, api, type OrganizationUser } from '@/lib/api';
import { OrgShell } from '@/components/org-shell';
import { TeamList } from '@/components/team-list';

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'READ_ONLY'] as const;

export default async function TeamPage() {
  const [t, me] = await Promise.all([getTranslations('team'), api.me()]);

  /**
   * Asking the server rather than deciding here.
   *
   * `me.capabilities` is the union across every membership — "what this person
   * can do somewhere" — so a manager scoped to one property appears to hold
   * `user:read` while the organization-wide list correctly refuses them.
   * Reproducing that rule in the client would be a second source of truth that
   * drifts; catching the refusal uses the only authority there is.
   */
  let users: OrganizationUser[] | null = null;
  try {
    users = await api.users();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error;
  }

  const myRank = Math.min(
    ...me.memberships
      // Only organization-wide memberships confer authority over other people;
      // being a manager at one property does not.
      .filter((membership) => membership.propertyId === null)
      .map((membership) => ROLES.indexOf(membership.role as (typeof ROLES)[number])),
  );
  const assignableRoles = ROLES.filter((_, index) => index >= myRank);

  return (
    <OrgShell>
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
          <p className="text-sm text-stone-500">{t('subtitle')}</p>
        </div>

        {users === null ? (
          // A refusal is an answer, not a crash. Before this the page died with
          // an unhandled server error for anyone without organization-wide
          // rights, which reads as "the product is broken".
          <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
            <p className="text-sm font-medium text-ink-700">{t('noAccess')}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('noAccessHint')}</p>
          </div>
        ) : (
          <TeamList
            users={users}
            currentUserId={me.id}
            assignableRoles={[...assignableRoles]}
            canInvite={me.capabilities.includes('user:invite')}
            canUpdate={me.capabilities.includes('user:update')}
          />
        )}
      </div>
    </OrgShell>
  );
}
