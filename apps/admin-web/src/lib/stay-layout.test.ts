import { describe, expect, it } from 'vitest';
import { freeRoomsPerNight, layoutStays } from './stay-layout';

const WINDOW = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'];

describe('layoutStays', () => {
  it('starts and ends a bar in the middle of its check-in and check-out days', () => {
    const [bar] = layoutStays(WINDOW, [{ checkIn: '2026-09-26', checkOut: '2026-09-28' }]);
    expect(bar).toMatchObject({ left: 1.5, width: 2, clippedStart: false, clippedEnd: false });
  });

  /**
   * The bug that made the old grid unusable: a guest who arrived before the
   * window's first night was not drawn at all, and the missing cells shifted
   * every later booking on the row onto the wrong day.
   */
  it('draws a stay that began before the window from the left edge, marked as cut', () => {
    const [bar] = layoutStays(WINDOW, [{ checkIn: '2026-09-23', checkOut: '2026-09-27' }]);
    expect(bar).toMatchObject({ left: 0, width: 2.5, clippedStart: true, clippedEnd: false });
  });

  it('cuts a stay running past the window at the right edge', () => {
    const [bar] = layoutStays(WINDOW, [{ checkIn: '2026-09-27', checkOut: '2026-10-05' }]);
    expect(bar).toMatchObject({ left: 2.5, width: 1.5, clippedStart: false, clippedEnd: true });
  });

  it('runs a stay leaving the morning after the last column to the edge, uncut', () => {
    const [bar] = layoutStays(WINDOW, [{ checkIn: '2026-09-28', checkOut: '2026-09-29' }]);
    expect(bar).toMatchObject({ left: 3.5, width: 0.5, clippedEnd: false });
  });

  it('omits stays with no night in the window', () => {
    const bars = layoutStays(WINDOW, [
      // Leaves on the first morning: its nights are all before the window.
      { checkIn: '2026-09-23', checkOut: '2026-09-25' },
      // Arrives the morning after the last column.
      { checkIn: '2026-09-29', checkOut: '2026-09-30' },
    ]);
    expect(bars).toHaveLength(0);
  });

  it('lets two stays turning over on the same day meet at the midpoint, on one lane', () => {
    const bars = layoutStays(WINDOW, [
      { checkIn: '2026-09-27', checkOut: '2026-09-28' },
      { checkIn: '2026-09-25', checkOut: '2026-09-27' },
    ]);
    expect(bars.map((bar) => [bar.left, bar.left + bar.width, bar.lane])).toEqual([
      [0.5, 2.5, 0],
      [2.5, 3.5, 0],
    ]);
  });

  it('stacks genuinely overlapping stays instead of hiding one', () => {
    const bars = layoutStays(WINDOW, [
      { checkIn: '2026-09-25', checkOut: '2026-09-28' },
      { checkIn: '2026-09-26', checkOut: '2026-09-27' },
    ]);
    expect(bars.map((bar) => bar.lane)).toEqual([0, 1]);
  });

  it('returns nothing for an empty window', () => {
    expect(layoutStays([], [{ checkIn: '2026-09-25', checkOut: '2026-09-26' }])).toEqual([]);
  });
});

describe('freeRoomsPerNight', () => {
  const rooms = [
    { isActive: true, stays: [{ checkIn: '2026-09-25', checkOut: '2026-09-27' }] },
    { isActive: true, stays: [] },
    // Out of service: never counted, even with nothing in it.
    { isActive: false, stays: [] },
  ];

  it('counts rooms with no stay covering the night, ignoring out-of-service rooms', () => {
    expect(freeRoomsPerNight(WINDOW, rooms)).toEqual([1, 1, 2, 2]);
  });

  it('treats the check-out day as free: the guest leaves in the morning', () => {
    expect(freeRoomsPerNight(['2026-09-27'], rooms)).toEqual([2]);
  });
});
