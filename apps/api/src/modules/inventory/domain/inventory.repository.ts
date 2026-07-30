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

  /**
   * Make room for units that a channel has ALREADY sold.
   *
   * Creates any missing night and raises allotment to `booked + units` where
   * capacity is short, returning the dates it had to touch.
   *
   * Only for inbound OTA bookings (domain-model.md §3.8). A guest holding a
   * confirmation from Agoda is real whether or not our count agreed, so the
   * choice is between recording the truth and pretending the booking does not
   * exist. Raising allotment records it honestly — the oversell becomes visible
   * in the data, reconciliation still balances, and staff get an alert. It must
   * never be reachable from a direct booking path, where the guard is the whole
   * point.
   */
  ensureCapacity(
    tx: Executor,
    scope: { organizationId: string; propertyId: string; roomTypeId: string },
    dates: readonly IsoDate[],
    units: number,
  ): Promise<readonly IsoDate[]>;

  /**
   * Apply a staff edit across a set of nights, creating any that do not exist.
   *
   * Only the fields present in `patch` are written, so setting a min-stay does
   * not silently reset allotment. Rows must be locked and validated by the
   * caller first — this does not check `booked`.
   */
  upsertRange(
    tx: Executor,
    scope: { organizationId: string; propertyId: string; roomTypeId: string },
    dates: readonly IsoDate[],
    patch: InventoryPatch,
  ): Promise<number>;

  /** Guarded decrement. Returns rows changed. */
  release(
    tx: Executor,
    roomTypeId: string,
    dates: readonly IsoDate[],
    units: number,
  ): Promise<number>;
}

export interface InventoryPatch {
  readonly allotment?: number;
  readonly stopSell?: boolean;
  readonly minStay?: number;
  readonly maxStay?: number | null;
  readonly closedToArrival?: boolean;
  readonly closedToDeparture?: boolean;
}

export const INVENTORY_REPOSITORY = Symbol('INVENTORY_REPOSITORY');
