import type { InventoryDay, InventoryGrid } from '@/lib/api';

/**
 * Units the desk can sell for one night: allotment minus booked, zero when
 * the night is closed or stop-sold. Same rule as the booking form.
 * closedToArrival only matters for arrivals, so it is deliberately ignored.
 */
export function sellableUnits(
  day: Pick<InventoryDay, 'open' | 'stopSell' | 'allotment' | 'booked'>,
): number {
  return day.open && !day.stopSell ? Math.max(0, day.allotment - day.booked) : 0;
}

/** roomTypeId -> date -> sellable units. Empty when the grid is unavailable. */
export function sellableByRoomType(
  grid: InventoryGrid | null,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const row of grid?.roomTypes ?? []) {
    result[row.roomTypeId] = Object.fromEntries(
      row.days.map((day) => [day.date, sellableUnits(day)]),
    );
  }
  return result;
}
