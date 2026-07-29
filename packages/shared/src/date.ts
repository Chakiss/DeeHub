/**
 * Hotel-night date arithmetic (ADR-0003).
 *
 * A hotel night is a CALENDAR DATE in the property's timezone, never an
 * instant. Every function here operates on "YYYY-MM-DD" strings using UTC
 * internals, so results never shift because the server, the developer, or a
 * daylight-saving boundary disagrees about what day it is.
 *
 * The classic bug this prevents: `new Date('2026-08-12')` is midnight UTC,
 * which in Asia/Bangkok (UTC+7) is already 07:00 on the 12th — but in
 * America/Los_Angeles it is still the 11th. Booking systems that store nights
 * as timestamps lose a night for half the planet.
 */

declare const isoDateBrand: unique symbol;

/** A calendar date in `YYYY-MM-DD` form. */
export type IsoDate = string & { readonly [isoDateBrand]: true };

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Round-trips only for real calendar dates, so 2026-02-30 is rejected.
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

export function toIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new DateError(`Invalid calendar date: "${value}" (expected YYYY-MM-DD)`);
  }
  return value;
}

export function isoDate(year: number, month: number, day: number): IsoDate {
  const padded = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day,
  ).padStart(2, '0')}`;
  return toIsoDate(padded);
}

function toUtcMillis(date: IsoDate): number {
  const match = ISO_DATE_PATTERN.exec(date);
  /* istanbul ignore next -- unreachable for branded IsoDate values */
  if (!match) throw new DateError(`Invalid calendar date: "${date}"`);
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

function fromUtcMillis(millis: number): IsoDate {
  const date = new Date(millis);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

const MILLIS_PER_DAY = 86_400_000;

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) {
    throw new DateError(`Day offset must be an integer, received ${days}`);
  }
  return fromUtcMillis(toUtcMillis(date) + days * MILLIS_PER_DAY);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / MILLIS_PER_DAY);
}

export function compareDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/**
 * The nights a stay occupies: `[checkIn, checkOut)`.
 *
 * Check-out day is NOT a night. A 12→14 August stay occupies the nights of
 * the 12th and 13th and consumes two units of inventory, not three.
 */
export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): IsoDate[] {
  const count = diffDays(checkIn, checkOut);
  if (count <= 0) {
    throw new DateError(`Check-out (${checkOut}) must be after check-in (${checkIn})`);
  }
  const nights: IsoDate[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    nights.push(addDays(checkIn, offset));
  }
  return nights;
}

/** Length of stay in nights. */
export function nightCount(checkIn: IsoDate, checkOut: IsoDate): number {
  const count = diffDays(checkIn, checkOut);
  if (count <= 0) {
    throw new DateError(`Check-out (${checkOut}) must be after check-in (${checkIn})`);
  }
  return count;
}

/** Every date in `[from, to)`. Used for inventory and rate grids. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const count = diffDays(from, to);
  if (count < 0) {
    throw new DateError(`Range end (${to}) must not precede start (${from})`);
  }
  const dates: IsoDate[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    dates.push(addDays(from, offset));
  }
  return dates;
}

export type DayOfWeek = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';

const DAY_NAMES: readonly DayOfWeek[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function dayOfWeek(date: IsoDate): DayOfWeek {
  const index = new Date(toUtcMillis(date)).getUTCDay();
  return DAY_NAMES[index] as DayOfWeek;
}

/**
 * The property's current business date.
 *
 * The ONLY correct way to ask "what is today?" in this system. A server in
 * us-central1 must not decide that a Bangkok hotel's business date rolled
 * over seven hours early.
 */
export function businessDate(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const lookup = (type: 'year' | 'month' | 'day'): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new DateError(`Unable to resolve ${type} for timezone "${timeZone}"`);
    return Number(part.value);
  };

  return isoDate(lookup('year'), lookup('month'), lookup('day'));
}
