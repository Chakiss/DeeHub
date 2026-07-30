import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { dateRange, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { roomTypes } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { availableUnits } from '../domain/inventory-day';
import { INVENTORY_REPOSITORY, type InventoryRepository } from '../domain/inventory.repository';

export interface InventoryGridDay {
  readonly date: IsoDate;
  readonly allotment: number;
  readonly booked: number;
  readonly available: number;
  readonly stopSell: boolean;
  readonly minStay: number;
  readonly maxStay: number | null;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
  /** False when the night has no row: never opened for sale, not "unlimited". */
  readonly open: boolean;
}

export interface InventoryGridRow {
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly days: readonly InventoryGridDay[];
}

export interface InventoryGrid {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly roomTypes: readonly InventoryGridRow[];
}

/**
 * The calendar grid behind the dashboard's main screen (api-spec.md §6.3).
 *
 * Returns a dense matrix — every room type gets an entry for every date in the
 * range, including nights with no row at all. The client should not have to
 * reconstruct gaps, and a missing night rendered as blank rather than "closed"
 * is how a hotel accidentally believes it is selling dates it never opened.
 */
@Injectable()
export class GetInventoryGridQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
  ) {}

  async execute(
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
    roomTypeIds: readonly string[] = [],
  ): Promise<InventoryGrid> {
    const organizationId = requireOrganizationId();

    const conditions = [
      eq(roomTypes.organizationId, organizationId),
      eq(roomTypes.propertyId, propertyId),
      eq(roomTypes.isActive, true),
    ];
    if (roomTypeIds.length > 0) {
      conditions.push(inArray(roomTypes.id, [...roomTypeIds]));
    }

    const types = await this.db
      .select({ id: roomTypes.id, code: roomTypes.code, name: roomTypes.name })
      .from(roomTypes)
      .where(and(...conditions))
      .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.code));

    if (types.length === 0) return { from, to, roomTypes: [] };

    const rows = await this.inventory.findRange(
      this.db,
      propertyId,
      types.map((type) => type.id),
      from,
      to,
    );

    const byRoomType = new Map<string, Map<string, (typeof rows)[number]>>();
    for (const row of rows) {
      const forType = byRoomType.get(row.roomTypeId) ?? new Map();
      forType.set(row.date, row);
      byRoomType.set(row.roomTypeId, forType);
    }

    const dates = dateRange(from, to);

    return {
      from,
      to,
      roomTypes: types.map((type) => {
        const forType = byRoomType.get(type.id);
        return {
          roomTypeId: type.id,
          code: type.code,
          name: type.name,
          days: dates.map((date) => {
            const row = forType?.get(date);
            if (!row) {
              // Closed, not blank: a night with no row cannot be sold.
              return {
                date,
                allotment: 0,
                booked: 0,
                available: 0,
                stopSell: false,
                minStay: 1,
                maxStay: null,
                closedToArrival: false,
                closedToDeparture: false,
                open: false,
              };
            }
            return {
              date,
              allotment: row.allotment,
              booked: row.booked,
              available: availableUnits(row),
              stopSell: row.stopSell,
              minStay: row.minStay,
              maxStay: row.maxStay,
              closedToArrival: row.closedToArrival,
              closedToDeparture: row.closedToDeparture,
              open: true,
            };
          }),
        };
      }),
    };
  }
}
