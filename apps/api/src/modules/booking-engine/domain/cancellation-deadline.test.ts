import { describe, expect, it } from 'vitest';
import { toIsoDate } from '@deehub/shared';
import { cancellationDeadline } from './cancellation-deadline';

const checkIn = toIsoDate('2026-10-10');

describe('cancellationDeadline', () => {
  it('is 24h before 14:00 Bangkok time on the check-in date', () => {
    const deadline = cancellationDeadline({
      checkIn,
      checkInTime: '14:00',
      timeZone: 'Asia/Bangkok',
      noticeHours: 24,
    });
    expect(deadline.toISOString()).toBe('2026-10-09T07:00:00.000Z');
  });

  it('accepts the HH:MM:SS form Postgres returns', () => {
    const deadline = cancellationDeadline({
      checkIn,
      checkInTime: '14:00:00',
      timeZone: 'Asia/Bangkok',
      noticeHours: 24,
    });
    expect(deadline.toISOString()).toBe('2026-10-09T07:00:00.000Z');
  });

  it('is the check-in time itself with zero notice', () => {
    const deadline = cancellationDeadline({
      checkIn,
      checkInTime: '14:00',
      timeZone: 'Asia/Bangkok',
      noticeHours: 0,
    });
    expect(deadline.toISOString()).toBe('2026-10-10T07:00:00.000Z');
  });

  it('honours another timezone (UTC-4 daylight time in New York)', () => {
    const deadline = cancellationDeadline({
      checkIn,
      checkInTime: '15:00',
      timeZone: 'America/New_York',
      noticeHours: 48,
    });
    // 15:00 EDT = 19:00Z on the 10th, two days earlier.
    expect(deadline.toISOString()).toBe('2026-10-08T19:00:00.000Z');
  });

  it('needs the second offset pass when the offset changes between guess and answer', () => {
    // New York springs forward on 2026-03-08 at 02:00. 03:30 that day is EDT
    // (UTC-4) = 07:30Z, but the first guess (03:30 read as UTC) is still in
    // EST, so a single pass would answer 08:30Z.
    const deadline = cancellationDeadline({
      checkIn: toIsoDate('2026-03-08'),
      checkInTime: '03:30',
      timeZone: 'America/New_York',
      noticeHours: 0,
    });
    expect(deadline.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('uses the offset in force on the check-in date across a DST change', () => {
    // New York leaves DST on 2026-11-01: 15:00 that day is EST (UTC-5).
    const deadline = cancellationDeadline({
      checkIn: toIsoDate('2026-11-01'),
      checkInTime: '15:00',
      timeZone: 'America/New_York',
      noticeHours: 0,
    });
    expect(deadline.toISOString()).toBe('2026-11-01T20:00:00.000Z');
  });
});
