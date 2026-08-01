'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Wordmark } from '@/components/wordmark';

/** Matches the API. A recovery path must not accept a weaker password. */
const MIN_LENGTH = 12;

/**
 * Choose a new password, using a link from an email.
 *
 * Two passwords are asked for. The usual argument against confirmation fields
 * is that the person can just reset again if they mistype — which is exactly
 * what does not apply here: the link is single-use, so a typo means going back
 * to the mailbox and waiting for another one.
 *
 * On success this sends the person to sign in rather than logging them in. The
 * API issues no session for a link that arrived by email; see the use case.
 */
export function ResetPasswordForm() {
  const t = useTranslations('resetPassword');
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirmation) {
      setError(t('mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/session/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? t('failed'));
        return;
      }

      const body = (await response.json()) as { organizationSlug: string };
      // Carry the slug over: it is the field nobody remembers, and somebody who
      // has just recovered an account should not then be stuck on it.
      const query = body.organizationSlug
        ? `?org=${encodeURIComponent(body.organizationSlug)}&reset=1`
        : '?reset=1';
      router.replace(`/login${query}`);
    } catch {
      setError(t('failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="brand-gradient flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark tone="light" size="lg" />
        </div>

        {token ? (
          <form
            onSubmit={(event) => void submit(event)}
            className="space-y-4 rounded-xl bg-white p-6 shadow-xl shadow-ink-950/25"
          >
            <h1 className="text-lg font-medium text-slate-900">{t('title')}</h1>

            <Field id="new-password" label={t('newPassword')} hint={t('hint', { min: MIN_LENGTH })}>
              <input
                id="new-password"
                aria-describedby="new-password-hint"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
                autoFocus
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </Field>

            <Field id="confirm-password" label={t('confirm')}>
              <input
                id="confirm-password"
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </Field>

            {error && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
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
        ) : (
          // Reached by typing the address, or by a mail client that mangled the
          // link. Saying so beats an empty form that fails on submit.
          <div className="space-y-4 rounded-xl bg-white p-6 shadow-xl shadow-ink-950/25">
            <h1 className="text-lg font-medium text-slate-900">{t('noTokenTitle')}</h1>
            <p className="text-sm text-slate-600">{t('noTokenBody')}</p>
            <Link
              href="/forgot-password"
              className="block w-full rounded-md bg-brand-600 px-3 py-2 text-center text-sm font-medium text-white transition hover:bg-brand-700"
            >
              {t('requestAnother')}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * Same shape as the change-password form's, and for the same reason: a hint
 * nested inside the label folds into the field's accessible name — "New
 * password At least 12 characters." — which is wrong for a screen reader and
 * ambiguous against "Confirm new password".
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
  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-slate-400">
          {hint}
        </span>
      )}
    </div>
  );
}
