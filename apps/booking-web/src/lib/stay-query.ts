import { addDays, isIsoDate, todayInBangkok } from './format';

export interface StayQuery {
  readonly checkIn: string;
  readonly checkOut: string;
  readonly adults: number;
  readonly children: number;
}

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function count(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
}

/**
 * Dates and guests from the URL, forgiving of every form they arrive in.
 *
 * Google's landing template sends `checkin=YYYY-MM-DD&nights=N`; the site's
 * own form sends `checkIn`/`checkOut`. Anything unparseable becomes a
 * sensible default — tomorrow for one night, two adults — rather than a
 * broken page, because the person who arrived here came to book.
 */
export function parseStay(params: Params): StayQuery {
  const today = todayInBangkok();
  const rawIn = one(params, 'checkIn') ?? one(params, 'checkin');
  const checkIn = isIsoDate(rawIn) && rawIn >= today ? rawIn : addDays(today, 1);

  const rawOut = one(params, 'checkOut') ?? one(params, 'checkout');
  const nights = count(one(params, 'nights'), 0, 30);
  let checkOut = isIsoDate(rawOut)
    ? rawOut
    : nights > 0
      ? addDays(checkIn, nights)
      : addDays(checkIn, 1);
  if (checkOut <= checkIn) checkOut = addDays(checkIn, 1);

  return {
    checkIn,
    checkOut,
    adults: Math.max(1, count(one(params, 'adults'), 2, 10)),
    children: count(one(params, 'children'), 0, 10),
  };
}

export function stayToSearch(
  stay: StayQuery,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams({
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: String(stay.adults),
    children: String(stay.children),
  });
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  return params.toString();
}
