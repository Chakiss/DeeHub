'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Wordmark } from '@/components/wordmark';

/**
 * "I cannot sign in."
 *
 * The screen never says whether the address was found, because the API does
 * not tell it — so the confirmation is written to be true either way: we have
 * sent a link IF the account exists. Wording that promised delivery would make
 * a person with a typo in their address wait for mail that is never coming.
 *
 * The organization slug is asked for again rather than carried over, because
 * the person arriving here may well have come from the full sign-in form where
 * they typed one that was wrong.
 */
export function ForgotPasswordForm({
  initialSlug,
  initialEmail,
}: {
  initialSlug: string;
  initialEmail: string;
}) {
  const t = useTranslations('forgotPassword');
  const locale = useLocale();

  const [organizationSlug, setOrganizationSlug] = useState(initialSlug);
  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await fetch('/api/session/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The language the person is reading the screen in is the only signal
        // anyone has for what language to write to them in: nobody is signed
        // in, so there is no property whose country could stand in for it.
        body: JSON.stringify({ organizationSlug, email, locale }),
      });
    } finally {
      // Shown even if the request itself failed. A network error here is
      // indistinguishable to the caller from an address that does not exist,
      // and both must look the same or the screen becomes the oracle the API
      // refuses to be.
      setSent(true);
      setSubmitting(false);
    }
  }

  return (
    <main className="brand-gradient flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark tone="light" size="lg" />
        </div>

        {sent ? (
          <div className="space-y-4 rounded-xl bg-white p-6 shadow-xl shadow-ink-950/25">
            <h1 className="text-lg font-medium text-slate-900">{t('sentTitle')}</h1>
            <p className="text-sm text-slate-600">{t('sentBody', { email })}</p>
            <p className="text-xs text-slate-400">{t('sentHint')}</p>
            <Link
              href="/login"
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-center text-sm text-slate-700 transition hover:bg-slate-50"
            >
              {t('backToSignIn')}
            </Link>
          </div>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="space-y-4 rounded-xl bg-white p-6 shadow-xl shadow-ink-950/25"
          >
            <h1 className="text-lg font-medium text-slate-900">{t('title')}</h1>
            <p className="text-sm text-slate-600">{t('intro')}</p>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                {t('organization')}
              </span>
              <input
                value={organizationSlug}
                onChange={(event) => setOrganizationSlug(event.target.value)}
                autoComplete="organization"
                required
                placeholder="deehub-demo"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{t('email')}</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                autoFocus
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {submitting ? t('submitting') : t('submit')}
            </button>

            <Link
              href="/login"
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-center text-sm text-slate-700 transition hover:bg-slate-50"
            >
              {t('backToSignIn')}
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
