/**
 * Where a stay's bar sits on the room × night grid.
 *
 * Pure arithmetic in column units — one unit is one night's column — so the
 * grid can draw with CSS and never measure anything, and so the one bug that
 * made the old table unusable is testable: a stay that began BEFORE the
 * window's first night used to be skipped, which dropped its cells from the
 * row and shifted every later booking onto the wrong day.
 *
 * Bars follow the PMS convention the front desk already knows from other
 * products: a stay starts in the MIDDLE of its check-in day and ends in the
 * middle of its check-out day. Two stays that turn over on the same day meet
 * at that midpoint instead of one of them being invisible, and "who arrives
 * today, who leaves today" is read off the picture rather than the dates.
 */

export interface StayLike {
  readonly checkIn: string;
  readonly checkOut: string;
}

export interface StayBar<T extends StayLike = StayLike> {
  readonly stay: T;
  /** Left edge, in columns from the window's first night. */
  readonly left: number;
  /** Width in columns. Always > 0. */
  readonly width: number;
  /** Began before the window: the bar is cut at the left edge. */
  readonly clippedStart: boolean;
  /** Ends after the window: the bar is cut at the right edge. */
  readonly clippedEnd: boolean;
  /**
   * Stacking row when two stays overlap in one room. Should not happen — the
   * database refuses overlapping assignments — but if it ever does, hiding one
   * of them is the wrong failure.
   */
  readonly lane: number;
}

function nextDay(date: string): string {
  const utc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + 1,
  );
  return new Date(utc).toISOString().slice(0, 10);
}

/**
 * `dates` are the window's NIGHTS, in order: the first is the first column and
 * the window ends the morning after the last. A stay is shown when at least
 * one of its nights is in the window; one leaving on the first morning is not
 * (its nights are all before), and one arriving the morning after the last
 * column is not either.
 */
export function layoutStays<T extends StayLike>(
  dates: readonly string[],
  stays: readonly T[],
): StayBar<T>[] {
  const first = dates[0];
  if (first === undefined) return [];
  const last = dates[dates.length - 1] ?? first;
  const end = nextDay(last);
  const columns = dates.length;
  const index = new Map(dates.map((date, position) => [date, position]));

  const bars: StayBar<T>[] = [];
  const sorted = [...stays].sort((a, b) => a.checkIn.localeCompare(b.checkIn));

  for (const stay of sorted) {
    if (stay.checkOut <= first || stay.checkIn >= end) continue;
    if (stay.checkOut <= stay.checkIn) continue;

    const clippedStart = stay.checkIn < first;
    const clippedEnd = stay.checkOut > end;

    const left = clippedStart ? 0 : (index.get(stay.checkIn) ?? 0) + 0.5;
    // Check-out on the morning after the last column is the window's own edge,
    // not a cut; only a later date is.
    const right = clippedEnd
      ? columns
      : stay.checkOut === end
        ? columns
        : (index.get(stay.checkOut) ?? columns) + 0.5;

    bars.push({
      stay,
      left,
      width: Math.max(right - left, 0.5),
      clippedStart,
      clippedEnd,
      lane: 0,
    });
  }

  // Lanes: greedy, first free. Bars already sorted by check-in.
  const laneEnds: number[] = [];
  return bars.map((bar) => {
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= bar.left);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = bar.left + bar.width;
    return { ...bar, lane };
  });
}

/**
 * How many rooms of a group are free on each night: rooms with no stay
 * covering the night, out-of-service rooms excluded.
 *
 * This is the desk's number — "where can I put someone tonight" — and
 * deliberately NOT the sellable count, which is allotment and lives on the
 * inventory grid (ADR-0002). A hotel can be sold out with three rooms free
 * here, or have a room free here on a night it chose not to sell.
 */
export function freeRoomsPerNight(
  dates: readonly string[],
  rooms: readonly { isActive: boolean; stays: readonly StayLike[] }[],
): number[] {
  return dates.map(
    (date) =>
      rooms.filter(
        (room) =>
          room.isActive && !room.stays.some((stay) => stay.checkIn <= date && stay.checkOut > date),
      ).length,
  );
}
