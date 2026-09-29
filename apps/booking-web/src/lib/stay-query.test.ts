import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStay } from './stay-query';

describe('parseStay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 23:30 in Bangkok on the 29th, which is still the 29th there and in UTC.
    vi.setSystemTime(new Date('2026-09-29T16:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to tonight for one night when no dates arrive', () => {
    expect(parseStay({})).toEqual({
      checkIn: '2026-09-29',
      checkOut: '2026-09-30',
      adults: 2,
      children: 0,
    });
  });

  it('keeps tonight when the guest asks for it', () => {
    const stay = parseStay({ checkIn: '2026-09-29', checkOut: '2026-09-30' });
    expect(stay.checkIn).toBe('2026-09-29');
    expect(stay.checkOut).toBe('2026-09-30');
  });

  it('moves a check-in that has passed to tonight', () => {
    const stay = parseStay({ checkin: '2026-09-28', nights: '2' });
    expect(stay.checkIn).toBe('2026-09-29');
    expect(stay.checkOut).toBe('2026-10-01');
  });

  it('turns the date over at midnight in Bangkok, not in UTC', () => {
    // 00:30 on the 30th in Bangkok is still 17:30 on the 29th in UTC.
    vi.setSystemTime(new Date('2026-09-29T17:30:00Z'));
    expect(parseStay({}).checkIn).toBe('2026-09-30');
  });

  it('never lets check-out fall on or before check-in', () => {
    const stay = parseStay({ checkIn: '2026-10-05', checkOut: '2026-10-05' });
    expect(stay.checkOut).toBe('2026-10-06');
  });
});
