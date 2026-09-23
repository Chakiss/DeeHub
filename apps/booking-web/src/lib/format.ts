import type { Locale } from '@/i18n/locale';

/** Minor units → "฿1,500" / "THB 1,500.00". Whole baht when there are no satang. */
export function formatMoney(minor: number, currency: string, locale: Locale): string {
  const major = minor / 100;
  return new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-US', {
    style: 'currency',
    currency,
    // "฿450" in both languages: the guest is in Thailand and knows the sign.
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

/** "2026-09-23" → "Wed 23 Sep 2026" / "พ. 23 ก.ย. 2569". Calendar dates, never shifted by a timezone. */
export function formatDate(iso: string, locale: Locale, style: 'short' | 'long' = 'short'): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    year: 'numeric',
  }).format(date);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
}

export function isIsoDate(value: string | undefined | null): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Today as a calendar date in Bangkok, the hotel's timezone (ADR-0003). */
export function todayInBangkok(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}
