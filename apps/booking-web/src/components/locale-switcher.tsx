'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/locale';

/** Plain links: `?lang=` is turned into the cookie by the middleware, so this works with JavaScript off. */
export function LocaleSwitcher() {
  const t = useTranslations('common');
  const current = useLocale() as Locale;
  const pathname = usePathname();
  const search = useSearchParams();

  return (
    <nav aria-label={t('language')} className="flex items-center gap-1 text-sm">
      {LOCALES.map((locale) => {
        const params = new URLSearchParams(search.toString());
        params.set('lang', locale);
        return (
          <a
            key={locale}
            href={`${pathname}?${params.toString()}`}
            aria-current={locale === current ? 'true' : undefined}
            className={
              locale === current
                ? 'rounded-md bg-ink-900 px-2 py-1 text-white'
                : 'rounded-md px-2 py-1 text-ink-700 hover:bg-sunk'
            }
          >
            {LOCALE_LABELS[locale]}
          </a>
        );
      })}
    </nav>
  );
}
