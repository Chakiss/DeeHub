import type { IsoDate } from '@deehub/shared';

/**
 * One night of sellable inventory for a room type (ADR-0002).
 *
 * A domain value, not a Drizzle row: the domain layer must not depend on
 * infrastructure (architecture.md §2).
 */
export interface InventoryDay {
  readonly roomTypeId: string;
  readonly date: IsoDate;
  readonly allotment: number;
  readonly booked: number;
  readonly stopSell: boolean;
  readonly minStay: number;
  readonly maxStay: number | null;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
}

export function availableUnits(day: InventoryDay): number {
  return day.allotment - day.booked;
}

export function hasCapacity(day: InventoryDay, units: number): boolean {
  return availableUnits(day) >= units;
}
