/**
 * Calendar-date helpers for the UI.
 *
 * Mirrors the rules in ADR-0003: a hotel night is a calendar date, and all
 * arithmetic goes through UTC so a date never shifts because of the viewer's
 * timezone or a daylight-saving boundary.
 */

const MILLIS_PER_DAY = 86_400_000;

export function addDays(date: string, days: number): string {
  const utc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + days,
  );
  return new Date(utc).toISOString().slice(0, 10);
}

/** Today in the PROPERTY's timezone, never the server's or the browser's. */
export function businessDate(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

export function weekdayLabel(date: string): string {
  const utc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return new Date(utc).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

export function dayLabel(date: string): string {
  const utc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return new Date(utc).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function isWeekend(date: string): boolean {
  const utc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  const day = new Date(utc).getUTCDay();
  return day === 5 || day === 6;
}

/**
 * Compact money for a calendar cell: "2,500", or "1,990.50" when there are
 * cents.
 *
 * No currency symbol — every price in the grid is in the property's own
 * currency (ADR-0003), so repeating it 21 times across a row costs width that
 * the availability numbers need. The currency is stated once, in the legend.
 */
export function formatMoneyCompact(amount: number, locale = 'en-US'): string {
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const major = Math.trunc(absolute / 100);
  const minor = absolute % 100;

  const majorText = new Intl.NumberFormat(locale).format(major);
  const text = minor === 0 ? majorText : `${majorText}.${String(minor).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** Integer minor units to a display string. Never divides by 100 as a float. */
export function formatMoney(amount: number, currency: string, locale = 'en-US'): string {
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const major = Math.trunc(absolute / 100);
  const minor = absolute % 100;
  const value = Number(`${negative ? '-' : ''}${String(major)}.${String(minor).padStart(2, '0')}`);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}
