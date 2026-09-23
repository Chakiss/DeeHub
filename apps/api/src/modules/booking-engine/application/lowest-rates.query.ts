import { Inject, Injectable } from '@nestjs/common';
import { dateRange, errors, money, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { availableUnits } from '../../inventory/domain/inventory-day';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import { RATE_REPOSITORY, type RateRepository } from '../../rates/domain/rate.repository';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRepository,
} from '../../room-types/domain/room-type.repository';
import { computeBreakdown } from '../../reservations/domain/pricing';
import type { PublicProperty } from './public-property.resolver';

/** A calendar, not a search: two months is what a page shows at once. */
const MAX_DAYS = 62;

export interface LowestNight {
  readonly date: IsoDate;
  /** What one night costs, all in, at the cheapest room's standard occupancy. Null = nothing to sell. */
  readonly fromTotalMinor: number | null;
}

/**
 * The "from ฿450" a guest sees on a calendar before choosing dates.
 *
 * Per night rather than per stay, so it cannot know about minimum stays or
 * closed-to-arrival — those are answered by the availability search once a
 * stay is named. What it does know: the night is not stopped, has a unit
 * left, and has at least one plan a stranger may buy. The figure is the
 * cheapest such plan's standard-occupancy price with tax and service charge
 * applied the same way a booking would apply them, so the number on the
 * calendar and the number on the checkout are computed by one function.
 */
@Injectable()
export class LowestRatesQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly roomTypes: RoomTypeRepository,
  ) {}

  async execute(property: PublicProperty, from: IsoDate, to: IsoDate): Promise<LowestNight[]> {
    const dates = dateRange(from, to);
    if (dates.length === 0) throw errors.validation('to must be after from');
    if (dates.length > MAX_DAYS) {
      throw errors.validation(`At most ${String(MAX_DAYS)} nights at a time`, { max: MAX_DAYS });
    }

    const types = (await this.roomTypes.list(this.db, property.propertyId)).filter(
      (type) => type.isActive,
    );
    if (types.length === 0) return dates.map((date) => ({ date, fromTotalMinor: null }));
    const typeIds = types.map((type) => type.id);

    const [inventory, leads] = await Promise.all([
      this.inventory.findRange(this.db, property.propertyId, typeIds, from, to),
      this.rates.findLeadRates(this.db, property.propertyId, typeIds, dates, { onlineOnly: true }),
    ]);

    const open = new Set(
      inventory
        .filter((day) => !day.stopSell && availableUnits(day) > 0)
        .map((day) => `${day.roomTypeId}|${day.date}`),
    );
    const cheapest = new Map<string, number>();
    for (const lead of leads) {
      if (!open.has(`${lead.roomTypeId}|${lead.date}`)) continue;
      const current = cheapest.get(lead.date);
      if (current === undefined || lead.amountMinor < current)
        cheapest.set(lead.date, lead.amountMinor);
    }

    const tax = {
      taxRateBp: property.taxRateBp,
      serviceChargeRateBp: property.serviceChargeRateBp,
      pricesIncludeTax: property.pricesIncludeTax,
    };
    return dates.map((date) => {
      const net = cheapest.get(date);
      if (net === undefined) return { date, fromTotalMinor: null };
      return {
        date,
        fromTotalMinor: computeBreakdown([money(net, property.currency)], property.currency, tax)
          .total.amount,
      };
    });
  }
}
