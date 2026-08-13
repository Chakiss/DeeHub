'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

const MIN_LENGTH = 12;

export function ChangePasswordForm() {
  const t = useTranslations('account');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);

    // Checked here as well as on the server. This one is purely a typo guard —
    // the server never sees the confirmation field, because a mistyped
    // replacement password would lock the user out of their own hotel.
    if (newPassword !== confirmPassword) {
      setError(t('mismatch'));
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      setError(t('tooShort'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/session/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? t('failed'));
        return;
      }

      // Clear the fields rather than leaving credentials sitting in component
      // state after they are no longer needed.
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
    } catch {
      setError(t('failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="max-w-sm space-y-4 rounded-2xl bg-white shadow-card p-6 shadow-sm"
    >
      <div>
        <h1 className="text-lg font-medium text-ink-900">{t('title')}</h1>
        <p className="mt-1 text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      <Field id="current-password" label={t('currentPassword')}>
        <input
          id="current-password"
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
          required
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </Field>

      <Field id="new-password" label={t('newPassword')} hint={t('hint')}>
        <input
          id="new-password"
          aria-describedby="new-password-hint"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          required
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </Field>

      <Field id="confirm-password" label={t('confirmPassword')}>
        <input
          id="confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          required
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </Field>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {done && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {t('success')}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {submitting ? t('submitting') : t('submit')}
      </button>
    </form>
  );
}

/**
 * The hint is attached with aria-describedby rather than nested inside the
 * label. Nesting it would fold the hint into the field's accessible name — "New
 * password At least 12 characters." — which is both wrong for a screen reader
 * and ambiguous against "Confirm new password".
 */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-stone-400">
          {hint}
        </span>
      )}
    </div>
  );
}
