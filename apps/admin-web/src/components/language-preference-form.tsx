'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/locale';
import { setPreferredLocale } from '@/app/account/actions';

/**
 * Account-level language. The header switch changes this browser; this
 * changes the account, and every browser the person signs in on from now.
 */
export function LanguagePreferenceForm({ current }: { current: Locale }) {
  const t = useTranslations('account');
  const router = useRouter();
  const [choice, setChoice] = useState<Locale>(current);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setPreferredLocale(choice);
      if (!result.ok) {
        setError(result.error?.message ?? t('languageFailed'));
        return;
      }
      setSaved(true);
      // Messages are resolved on the server: nothing changes until it renders again.
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="max-w-sm space-y-4 rounded-2xl border border-stone-200/70 bg-white shadow-card p-6 shadow-sm"
    >
      <div>
        <h2 className="text-lg font-medium text-ink-900">{t('languageTitle')}</h2>
        <p className="mt-1 text-sm text-stone-500">{t('languageSubtitle')}</p>
      </div>

      <div>
        <label htmlFor="preferred-locale" className="mb-1 block text-sm font-medium text-ink-700">
          {t('language')}
        </label>
        <select
          id="preferred-locale"
          value={choice}
          onChange={(event) => setChoice(event.target.value as Locale)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_LABELS[locale]}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {t('languageSaved')}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || choice === current}
        className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? t('languageSaving') : t('languageSave')}
      </button>
    </form>
  );
}
