/**
 * Supported locales.
 *
 * English stays the default because ADR-0003 says so — the UI is English-first
 * with i18n wired from day one, precisely so Thai could be added as a locale
 * file rather than a refactor. Flipping the default is a product decision, not
 * a side effect of adding a translation, so it is left alone here.
 *
 * Free of `server-only` and of `next/headers`: the switcher is a client
 * component and needs these names too.
 */
export const LOCALES = ['en', 'th'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'deehub_locale';

/** A year: a hotel's staff do not change language twice. */
export const LOCALE_MAX_AGE = 365 * 24 * 60 * 60;

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  th: 'ไทย',
};

/** Anything unrecognised falls back rather than throwing on a stale cookie. */
export function parseLocale(value: string | undefined): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}
