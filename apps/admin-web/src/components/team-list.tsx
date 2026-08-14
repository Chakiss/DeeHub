'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { InvitedUser, OrganizationUser } from '@/lib/api';
import { inviteUser, resetUserPassword, updateUser } from '@/app/team/actions';

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'READ_ONLY'] as const;

export function TeamList({
  users,
  currentUserId,
  assignableRoles,
  canInvite,
  canUpdate,
}: {
  users: OrganizationUser[];
  currentUserId: string;
  /** Roles at or below the viewer's own — the server enforces the same rule. */
  assignableRoles: string[];
  canInvite: boolean;
  canUpdate: boolean;
}) {
  const t = useTranslations('team');
  const roleNames = useTranslations('roles');

  const [inviting, setInviting] = useState(false);
  const [credential, setCredential] = useState<{
    title: string;
    intro: string;
    email: string;
    password: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleStatus(user: OrganizationUser) {
    setError(null);
    startTransition(async () => {
      const result = await updateUser(user.id, {
        status: user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED',
      });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  function resetPassword(user: OrganizationUser) {
    setError(null);
    startTransition(async () => {
      const result = await resetUserPassword(user.id);
      if (!result.ok || !result.reset) {
        setError(result.error?.message ?? t('failed'));
        return;
      }
      setCredential({
        title: t('resetTitle'),
        intro: t('resetIntro', { name: result.reset.fullName }),
        email: result.reset.email,
        password: result.reset.temporaryPassword,
      });
    });
  }

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  /*
   * Names are editable in place. The pilot's first account was created with a
   * template placeholder typed into Full name — "<อีเมลเจ้าของโรงแรม>" — and
   * there was no way to correct it from the screen, so the placeholder was on
   * its way into every audit entry. The server has allowed renames all along
   * (self included: "renaming yourself is fine"); only the control was missing.
   */
  function saveName(user: OrganizationUser) {
    const fullName = nameDraft.trim();
    if (!fullName || fullName === user.fullName) {
      setRenamingId(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateUser(user.id, { fullName });
      if (!result.ok) {
        setError(result.error?.message ?? t('failed'));
        return;
      }
      setRenamingId(null);
    });
  }

  function changeRole(user: OrganizationUser, role: string) {
    setError(null);
    startTransition(async () => {
      const result = await updateUser(user.id, { role });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  return (
    <div className="space-y-3">
      {canInvite && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setInviting(true)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('invite')}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
              <th className="px-3 py-2 font-medium">{t('email')}</th>
              <th className="px-3 py-2 font-medium">{t('fullName')}</th>
              <th className="px-3 py-2 font-medium">{t('role')}</th>
              <th className="px-3 py-2 font-medium">{t('status')}</th>
              <th className="px-3 py-2 font-medium">{t('lastLogin')}</th>
              {canUpdate && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const role = user.memberships[0]?.role ?? 'READ_ONLY';
              const isSelf = user.id === currentUserId;
              // Matches the server rule; the server rejects it regardless.
              const mayAdminister = canUpdate && !isSelf && assignableRoles.includes(role);

              return (
                <tr
                  key={user.id}
                  className={`border-b border-stone-100 last:border-0 ${
                    user.status === 'DISABLED' ? 'bg-sunk/60 text-stone-400' : ''
                  }`}
                >
                  <td className="px-3 py-2 text-ink-800">{user.email}</td>
                  <td className="px-3 py-2 text-stone-600">
                    {renamingId === user.id ? (
                      <span className="flex items-center gap-1.5">
                        <input
                          aria-label={`${t('fullName')} — ${user.email}`}
                          value={nameDraft}
                          disabled={pending}
                          autoFocus
                          onChange={(event) => setNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              saveName(user);
                            }
                            if (event.key === 'Escape') setRenamingId(null);
                          }}
                          className="w-40 rounded-md border border-stone-300 px-2 py-1 text-sm"
                        />
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => saveName(user)}
                          className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                        >
                          {t('saveName')}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setRenamingId(null)}
                          className="rounded-md px-2 py-1 text-xs text-stone-500 hover:text-ink-800"
                        >
                          {t('cancelName')}
                        </button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        {user.fullName}
                        {(mayAdminister || isSelf) && (
                          <button
                            type="button"
                            aria-label={`${t('editName')} — ${user.email}`}
                            title={t('editName')}
                            disabled={pending}
                            onClick={() => {
                              setRenamingId(user.id);
                              setNameDraft(user.fullName);
                            }}
                            className="rounded p-0.5 text-stone-400 hover:bg-sunk hover:text-ink-800"
                          >
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                              <path
                                d="m11.1 2.4 2.5 2.5M2.5 13.5l.6-3 7.6-7.6a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2l-7.6 7.6-3 .6Z"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {mayAdminister ? (
                      <select
                        aria-label={`${t('role')} — ${user.email}`}
                        value={role}
                        disabled={pending}
                        onChange={(event) => changeRole(user, event.target.value)}
                        className="rounded-md border border-stone-300 px-2 py-1 text-xs"
                      >
                        {ROLES.filter((candidate) => assignableRoles.includes(candidate)).map(
                          (candidate) => (
                            <option key={candidate} value={candidate}>
                              {roleNames(candidate)}
                            </option>
                          ),
                        )}
                      </select>
                    ) : (
                      <span className="text-stone-600">{roleNames(role)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        user.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-stone-200 text-stone-600'
                      }`}
                    >
                      {user.status === 'ACTIVE' ? t('active') : t('disabled')}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-stone-500">
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleDateString()
                      : t('never')}
                  </td>
                  {canUpdate && (
                    <td className="px-3 py-2 text-right">
                      {mayAdminister && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => toggleStatus(user)}
                          className="rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
                        >
                          {user.status === 'DISABLED' ? t('enable') : t('disable')}
                        </button>
                      )}
                      {mayAdminister && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => resetPassword(user)}
                          className="ml-2 rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
                        >
                          {t('reset')}
                        </button>
                      )}
                      {/* Explains the absent control rather than leaving it blank. */}
                      {isSelf && <span className="text-xs text-stone-400">{t('cannotSelf')}</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canUpdate && <p className="text-xs text-stone-400">{t('noDelete')}</p>}

      {inviting && (
        <InviteDialog
          assignableRoles={assignableRoles}
          onClose={() => setInviting(false)}
          onCreated={(user) => {
            setInviting(false);
            setCredential({
              title: t('passwordTitle'),
              intro: t('passwordIntro', { name: user.fullName }),
              email: user.email,
              password: user.temporaryPassword,
            });
          }}
        />
      )}

      {credential && (
        <CredentialDialog credential={credential} onClose={() => setCredential(null)} />
      )}
    </div>
  );
}

function InviteDialog({
  assignableRoles,
  onClose,
  onCreated,
}: {
  assignableRoles: string[];
  onClose: () => void;
  onCreated: (user: InvitedUser) => void;
}) {
  const t = useTranslations('team');
  const roleNames = useTranslations('roles');

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState(assignableRoles.at(-1) ?? 'READ_ONLY');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('invite')}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:items-center"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setSaving(true);
          const result = await inviteUser({ email, fullName, role });
          setSaving(false);
          if (!result.ok || !result.user) {
            setError(
              result.error?.code === 'CONFLICT'
                ? t('emailTaken')
                : (result.error?.message ?? t('failed')),
            );
            return;
          }
          onCreated(result.user);
        }}
        className="w-full max-w-md space-y-4 rounded-2xl border border-stone-200/70 bg-white shadow-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-ink-900">{t('invite')}</h2>

        <div>
          <label htmlFor="invite-email" className="mb-1 block text-sm font-medium text-ink-700">
            {t('email')}
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <div>
          <label htmlFor="invite-name" className="mb-1 block text-sm font-medium text-ink-700">
            {t('fullName')}
          </label>
          <input
            id="invite-name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            required
            maxLength={200}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <div>
          <label htmlFor="invite-role" className="mb-1 block text-sm font-medium text-ink-700">
            {t('role')}
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {assignableRoles.map((candidate) => (
              <option key={candidate} value={candidate}>
                {roleNames(candidate)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-stone-400">{t('roleHint')}</span>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * A one-time credential, from an invite or a reset.
 *
 * Shown here and nowhere else: it is not stored in readable form, so closing
 * this dialog is the last chance to read it. There is no outbound email yet,
 * which is why a human has to relay it.
 */
function CredentialDialog({
  credential,
  onClose,
}: {
  credential: { title: string; intro: string; email: string; password: string };
  onClose: () => void;
}) {
  const t = useTranslations('team');
  const [copied, setCopied] = useState(false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={credential.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
    >
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-stone-200/70 bg-white shadow-card p-6 shadow-lg">
        <h2 className="text-lg font-medium text-ink-900">{credential.title}</h2>
        <p className="text-sm text-stone-600">{credential.intro}</p>

        <dl className="space-y-2 rounded-md bg-sunk p-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-stone-500">{t('email')}</dt>
            <dd className="font-mono text-ink-800">{credential.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-stone-500">{t('password')}</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-ink-900">{credential.password}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(credential.password);
                  setCopied(true);
                }}
                className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-white"
              >
                {copied ? t('copied') : t('copy')}
              </button>
            </dd>
          </div>
        </dl>

        <p className="text-xs text-stone-500">{t('passwordAdvise')}</p>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
