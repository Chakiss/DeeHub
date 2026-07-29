import type { IsoDate, Money } from '@deehub/shared';
import type { Executor } from '../../../database/executor';

/**
 * Rate lookup for pricing a stay.
 *
 * Prices returned here are SNAPSHOTTED onto the reservation's nights. Nothing
 * re-reads them later: changing a rate plan must never alter what a guest was
 * already quoted (domain-model.md §3.5).
 */
export interface RateRepository {
  /**
   * Prices for the given nights at the given occupancy.
   *
   * Nights with no configured price are simply absent from the map; the caller
   * decides whether that is an error. Returning a zero would silently give
   * away rooms.
   */
  findPrices(
    tx: Executor,
    ratePlanId: string,
    dates: readonly IsoDate[],
    occupancy: number,
  ): Promise<Map<string, Money>>;
}

export const RATE_REPOSITORY = Symbol('RATE_REPOSITORY');
