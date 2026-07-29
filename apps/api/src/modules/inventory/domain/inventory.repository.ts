import type { IsoDate } from '@deehub/shared';
import type { Executor } from '../../../database/executor';
import type { InventoryDay } from './inventory-day';

/**
 * Inventory persistence port (Repository Pattern).
 *
 * Only this module may change `booked`. Reservations ask for a hold; nothing
 * else writes the column (ADR-0002).
 */
export interface InventoryRepository {
  /**
   * Load and LOCK the given dates, ordered by date.
   *
   * Deterministic lock ordering is what makes deadlocks impossible when two
   * bookings overlap on some but not all nights (docs/database.md §11.1).
   * Must be called inside a transaction.
   */
  lockDates(tx: Executor, roomTypeId: string, dates: readonly IsoDate[]): Promise<InventoryDay[]>;

  /** Read without locking, for calendars and availability search. */
  findRange(
    tx: Executor,
    propertyId: string,
    roomTypeIds: readonly string[],
    from: IsoDate,
    toExclusive: IsoDate,
  ): Promise<InventoryDay[]>;

  /**
   * Guarded increment of `booked`.
   *
   * Returns the number of rows changed; the caller MUST reject the booking
   * unless it equals `dates.length`. This is the last line of defence even
   * when the rows are already locked.
   */
  hold(tx: Executor, roomTypeId: string, dates: readonly IsoDate[], units: number): Promise<number>;

  /** Guarded decrement. Returns rows changed. */
  release(
    tx: Executor,
    roomTypeId: string,
    dates: readonly IsoDate[],
    units: number,
  ): Promise<number>;
}

export const INVENTORY_REPOSITORY = Symbol('INVENTORY_REPOSITORY');
