/**
 * Supported locales. Thai first: this page is read by a guest, most of whom
 * found the hotel on Google Maps in Thailand — unlike the dashboard, which is
 * English-first by ADR-0003 for the staff who run several properties.
 *
 * Free of `server-only` and `next/headers`: client components need the names.
 */
export const LOCALES = ['th', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'th';

/** Shared with the dashboard on the same apex, so a switch there is a switch here. */
export const LOCALE_COOKIE = 'deehub_locale';

export const LOCALE_MAX_AGE = 365 * 24 * 60 * 60;

export const LOCALE_LABELS: Record<Locale, string> = {
  th: 'ไทย',
  en: 'English',
};

export function parseLocale(value: string | undefined | null): Locale | null {
  return LOCALES.includes(value as Locale) ? (value as Locale) : null;
}
