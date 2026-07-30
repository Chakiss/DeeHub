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

  /**
   * Every occupancy price for several rate plans over a date range.
   *
   * Used when assembling an ARI push: OTAs expect the full occupancy ladder for
   * each rate, not just the one a guest happened to book.
   */
  findRatesForPlans(
    tx: Executor,
    ratePlanIds: readonly string[],
    dates: readonly IsoDate[],
  ): Promise<readonly RateRow[]>;

  /**
   * The lowest active price per room type per night, at that room type's
   * standard occupancy — the "from" price a guest sees.
   *
   * Lowest rather than a nominated plan: a room type usually carries several
   * (non-refundable, breakfast included, and so on), and the cheapest is what
   * an OTA advertises, so it is the number an operator is deciding against.
   * `planCount` says how many plans priced that night, because a single figure
   * standing for five plans is worth knowing about.
   *
   * A night missing from the result has NO price. That is not the same as free:
   * a night with allotment and no rate cannot be booked at all.
   */
  findLeadRates(
    tx: Executor,
    propertyId: string,
    roomTypeIds: readonly string[],
    dates: readonly IsoDate[],
  ): Promise<readonly LeadRate[]>;
}

export interface LeadRate {
  readonly roomTypeId: string;
  readonly date: IsoDate;
  readonly amountMinor: number;
  readonly currency: string;
  readonly planCount: number;
}

export interface RateRow {
  readonly ratePlanId: string;
  readonly date: IsoDate;
  readonly occupancy: number;
  readonly amountMinor: number;
  readonly currency: string;
}

export const RATE_REPOSITORY = Symbol('RATE_REPOSITORY');
