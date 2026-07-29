import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDate,
  compareDates,
  dateRange,
  DateError,
  dayOfWeek,
  diffDays,
  isIsoDate,
  isoDate,
  maxDate,
  minDate,
  nightCount,
  nightsBetween,
  toIsoDate,
} from './date';

describe('isIsoDate()', () => {
  it('accepts real calendar dates', () => {
    expect(isIsoDate('2026-08-12')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true); // leap year
  });

  it('rejects impossible dates rather than silently rolling them over', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2027-02-29')).toBe(false); // not a leap year
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-00-10')).toBe(false);
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(isIsoDate('12/08/2026')).toBe(false);
    expect(isIsoDate('2026-8-12')).toBe(false);
    expect(isIsoDate('2026-08-12T00:00:00Z')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('throws with a useful message via toIsoDate', () => {
    expect(() => toIsoDate('2026-02-30')).toThrow(DateError);
  });
});

describe('nightsBetween()', () => {
  it('excludes the departure day — check-out is not a night', () => {
    expect(nightsBetween(toIsoDate('2026-08-12'), toIsoDate('2026-08-15'))).toEqual([
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  it('returns a single night for a one-night stay', () => {
    expect(nightsBetween(toIsoDate('2026-08-12'), toIsoDate('2026-08-13'))).toEqual(['2026-08-12']);
  });

  it('rejects a zero-night stay', () => {
    expect(() => nightsBetween(toIsoDate('2026-08-12'), toIsoDate('2026-08-12'))).toThrow(
      DateError,
    );
  });

  it('rejects reversed dates', () => {
    expect(() => nightsBetween(toIsoDate('2026-08-15'), toIsoDate('2026-08-12'))).toThrow(
      DateError,
    );
  });

  it('counts nights across a month boundary', () => {
    const nights = nightsBetween(toIsoDate('2026-08-30'), toIsoDate('2026-09-02'));
    expect(nights).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
    expect(nightCount(toIsoDate('2026-08-30'), toIsoDate('2026-09-02'))).toBe(3);
  });

  it('counts nights across a year boundary', () => {
    expect(nightsBetween(toIsoDate('2026-12-31'), toIsoDate('2027-01-02'))).toEqual([
      '2026-12-31',
      '2027-01-01',
    ]);
  });

  it('is unaffected by daylight-saving transitions', () => {
    // Europe/London springs forward on 2026-03-29. A naive local-time
    // implementation loses or duplicates a night here.
    expect(nightCount(toIsoDate('2026-03-28'), toIsoDate('2026-03-31'))).toBe(3);
    // US DST boundary, 2026-11-01.
    expect(nightCount(toIsoDate('2026-10-31'), toIsoDate('2026-11-03'))).toBe(3);
  });

  it('handles a long stay spanning a leap day', () => {
    expect(nightCount(toIsoDate('2028-02-27'), toIsoDate('2028-03-02'))).toBe(4);
  });
});

describe('addDays() / diffDays()', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays(toIsoDate('2026-08-31'), 1)).toBe('2026-09-01');
    expect(addDays(toIsoDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(toIsoDate('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('adds a leap day correctly', () => {
    expect(addDays(toIsoDate('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addDays(toIsoDate('2027-02-28'), 1)).toBe('2027-03-01');
  });

  it('measures a 365-day horizon', () => {
    expect(diffDays(toIsoDate('2026-01-01'), toIsoDate('2027-01-01'))).toBe(365);
  });

  it('returns negative differences for reversed ranges', () => {
    expect(diffDays(toIsoDate('2026-08-15'), toIsoDate('2026-08-12'))).toBe(-3);
  });

  it('rejects fractional offsets', () => {
    expect(() => addDays(toIsoDate('2026-08-12'), 1.5)).toThrow(DateError);
  });
});

describe('dateRange()', () => {
  it('is end-exclusive, matching inventory grid queries', () => {
    expect(dateRange(toIsoDate('2026-08-01'), toIsoDate('2026-08-04'))).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
    ]);
  });

  it('allows an empty range', () => {
    expect(dateRange(toIsoDate('2026-08-01'), toIsoDate('2026-08-01'))).toEqual([]);
  });
});

describe('ordering helpers', () => {
  it('compares, mins and maxes', () => {
    const a = toIsoDate('2026-08-12');
    const b = toIsoDate('2026-08-15');
    expect(compareDates(a, b)).toBe(-1);
    expect(compareDates(b, a)).toBe(1);
    expect(compareDates(a, a)).toBe(0);
    expect(minDate(a, b)).toBe(a);
    expect(maxDate(a, b)).toBe(b);
  });
});

describe('dayOfWeek()', () => {
  it('identifies weekdays for weekday-filtered bulk updates', () => {
    expect(dayOfWeek(toIsoDate('2026-07-29'))).toBe('WED');
    expect(dayOfWeek(toIsoDate('2026-08-01'))).toBe('SAT');
    expect(dayOfWeek(toIsoDate('2026-08-02'))).toBe('SUN');
  });
});

describe('businessDate()', () => {
  it('uses the property timezone, not the server timezone', () => {
    // 2026-08-11 18:30 UTC is already 2026-08-12 in Bangkok (UTC+7)
    // but still 2026-08-11 in Los Angeles.
    const instant = new Date('2026-08-11T18:30:00Z');
    expect(businessDate('Asia/Bangkok', instant)).toBe('2026-08-12');
    expect(businessDate('America/Los_Angeles', instant)).toBe('2026-08-11');
    expect(businessDate('UTC', instant)).toBe('2026-08-11');
  });

  it('rolls over at local midnight', () => {
    // 16:59:59 UTC = 23:59:59 in Bangkok, still the 11th.
    expect(businessDate('Asia/Bangkok', new Date('2026-08-11T16:59:59Z'))).toBe('2026-08-11');
    // 17:00:00 UTC = 00:00:00 on the 12th in Bangkok.
    expect(businessDate('Asia/Bangkok', new Date('2026-08-11T17:00:00Z'))).toBe('2026-08-12');
  });

  it('returns a valid IsoDate for the current instant', () => {
    expect(isIsoDate(businessDate('Asia/Bangkok'))).toBe(true);
  });
});

describe('isoDate()', () => {
  it('zero-pads components', () => {
    expect(isoDate(2026, 8, 1)).toBe('2026-08-01');
  });

  it('rejects invalid component combinations', () => {
    expect(() => isoDate(2026, 2, 30)).toThrow(DateError);
  });
});
