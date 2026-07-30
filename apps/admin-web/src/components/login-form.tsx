'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import type { LastAccount } from '@/lib/session-config';
import { Wordmark } from '@/components/wordmark';
import { LocaleSwitcher } from '@/components/locale-switcher';

/**
 * Sign in, with the last account on this browser offered back.
 *
 * The organization slug is the field nobody can remember: it is an identifier
 * the product chose, not something hotel staff know. Remembering it turns the
 * everyday case — the same person, the same machine — into typing a password.
 *
 * Deliberately NOT solved by making email globally unique and dropping the
 * slug. Email is unique per organization on purpose (the same person can work
 * for two hotels), and looking an address up across tenants would mean either
 * verifying a password against every candidate account — N scrypt hashes per
 * attempt on an unauthenticated endpoint — or telling the caller that an
 * address exists somewhere, which is exactly what the uniform error message
 * elsewhere in login is there to avoid.
 */
export function LoginForm({ lastAccount }: { lastAccount: LastAccount | null }) {
  const t = useTranslations('login');
  const router = useRouter();
  const params = useSearchParams();

  // Start on the remembered card when there is one, and fall back to the full
  // form the moment the person says it is not them.
  const [remembered, setRemembered] = useState<LastAccount | null>(lastAccount);

  const [organizationSlug, setOrganizationSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(credentials: {
    organizationSlug: string;
    email: string;
    password: string;
  }) {
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/session/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        // The API deliberately returns one message for every failure mode, so
        // there is nothing more specific to show — and inventing detail here
        // would undo its protection against user enumeration.
        setError(body.error?.message ?? t('failed'));
        return;
      }

      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : '/');
      router.refresh();
    } catch {
      setError(t('failed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function forget() {
    await fetch('/api/session/forget-account', { method: 'POST' });
    setRemembered(null);
    setPassword('');
    setError(null);
  }

  return (
    // The one screen where the brand leads rather than frames: the logo's own
    // navy-to-azure gradient, with the card floating on it.
    <main className="brand-gradient flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Wordmark tone="light" size="lg" showTagline />
          {/* Before signing in, not after: this is the first screen a Thai
              receptionist meets. */}
          <LocaleSwitcher />
        </div>

        {remembered ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit({
                organizationSlug: remembered.organizationSlug,
                email: remembered.email,
                password,
              });
            }}
            className="space-y-4 rounded-xl bg-white p-6 shadow-xl shadow-ink-950/25"
          >
            <h1 className="text-lg font-medium text-slate-900">{t('welcomeBack')}</h1>

            <div className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold uppercase text-brand-700"
              >
                {remembered.fullName.trim().charAt(0) || '?'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">
                  {remembered.fullName}
                </span>
                <span className="block truncate text-xs text-slate-500">{remembered.email}</span>
                <span className="block truncate text-xs text-slate-400">
                  {remembered.organizationSlug}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void forget()}
                aria-label={t('forget')}
                title={t('forget')}
                className="shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            <Field label={t('password')}>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                // The only field on this path, so it should be ready to type in.
                autoFocus
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

            <button
              type="button"
              onClick={() => void forget()}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
            >
              {t('useAnotherAccount')}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit({ organizationSlug, email, password });
            }}
            className="space-y-4 rounded-xl bg-white p-6 shadow-xl shadow-ink-950/25"
          >
            <h1 className="text-lg font-medium text-slate-900">{t('title')}</h1>

            <Field label={t('organization')} hint={t('organizationHint')}>
              <input
                value={organizationSlug}
                onChange={(event) => setOrganizationSlug(event.target.value)}
                autoComplete="organization"
                required
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                placeholder="deehub-demo"
              />
            </Field>

            <Field label={t('email')}>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </Field>

            <Field label={t('password')}>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
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
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
