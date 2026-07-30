'use client';

import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useTransition } from 'react';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/locale';

/**
 * Language switch.
 *
 * Writes through a route handler rather than `document.cookie` so the choice
 * is set the same way on every path, then refreshes: messages are resolved on
 * the server, so nothing changes until the server renders again.
 */
export function LocaleSwitcher({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: string) {
    startTransition(async () => {
      await fetch('/api/session/locale', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      router.refresh();
    });
  }

  return (
    <select
      value={locale}
      disabled={pending}
      onChange={(event) => choose(event.target.value)}
      aria-label="Language"
      className={
        tone === 'light'
          ? 'rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs text-white disabled:opacity-60 [&>option]:text-slate-900'
          : 'rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-60'
      }
    >
      {LOCALES.map((option: Locale) => (
        <option key={option} value={option}>
          {LOCALE_LABELS[option]}
        </option>
      ))}
    </select>
  );
}
