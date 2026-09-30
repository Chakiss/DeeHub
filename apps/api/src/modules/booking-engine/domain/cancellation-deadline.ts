import type { IsoDate } from '@deehub/shared';

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east is positive). */
function zoneOffsetMillis(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

export interface CancellationDeadlineInput {
  readonly checkIn: IsoDate | string;
  /** `HH:MM` or `HH:MM:SS`, as Postgres `time` returns it. */
  readonly checkInTime: string;
  readonly timeZone: string;
  readonly noticeHours: number;
}

/**
 * The last instant a guest may cancel and still be inside the notice window:
 * the property's check-in time on the check-in date, read as wall-clock time in
 * the property's timezone, minus `noticeHours`.
 *
 * Hotel dates are calendar dates in the property timezone (ADR-0003), so the
 * wall-clock time is converted to an instant here and nowhere else. Cancelling
 * exactly AT the deadline is in time (`now <= deadline`).
 *
 * Two documented edges, deliberately not "fixed":
 * - A check-in time that falls inside a spring-forward gap (a wall-clock time
 *   that does not exist that day) resolves an hour early.
 * - `noticeHours` are absolute elapsed hours, so across a clock change "24h
 *   before" is not the same wall-clock time the previous day.
 */
export function cancellationDeadline(input: CancellationDeadlineInput): Date {
  const [year, month, day] = input.checkIn.split('-').map(Number) as [number, number, number];
  const [hour = 0, minute = 0] = input.checkInTime.split(':').map(Number);

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The offset can differ between the guess and the real instant when a DST
  // change falls in between, so it is resolved twice.
  const first = wallClockAsUtc - zoneOffsetMillis(input.timeZone, wallClockAsUtc);
  const instant = wallClockAsUtc - zoneOffsetMillis(input.timeZone, first);

  return new Date(instant - input.noticeHours * 3_600_000);
}
