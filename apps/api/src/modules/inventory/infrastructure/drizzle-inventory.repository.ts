import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { IsoDate } from '@deehub/shared';
import { toIsoDate } from '@deehub/shared';
import { inventoryDays } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import type { InventoryDay } from '../domain/inventory-day';
import type { InventoryRepository } from '../domain/inventory.repository';

interface InventoryRow {
  roomTypeId: string;
  date: string;
  allotment: number;
  booked: number;
  stopSell: boolean;
  minStay: number;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
}

function toDomain(row: InventoryRow): InventoryDay {
  return {
    roomTypeId: row.roomTypeId,
    date: toIsoDate(row.date),
    allotment: row.allotment,
    booked: row.booked,
    stopSell: row.stopSell,
    minStay: row.minStay,
    maxStay: row.maxStay,
    closedToArrival: row.closedToArrival,
    closedToDeparture: row.closedToDeparture,
  };
}

@Injectable()
export class DrizzleInventoryRepository implements InventoryRepository {
  async lockDates(
    tx: Executor,
    roomTypeId: string,
    dates: readonly IsoDate[],
  ): Promise<InventoryDay[]> {
    if (dates.length === 0) return [];

    const rows = await tx
      .select({
        roomTypeId: inventoryDays.roomTypeId,
        date: inventoryDays.date,
        allotment: inventoryDays.allotment,
        booked: inventoryDays.booked,
        stopSell: inventoryDays.stopSell,
        minStay: inventoryDays.minStay,
        maxStay: inventoryDays.maxStay,
        closedToArrival: inventoryDays.closedToArrival,
        closedToDeparture: inventoryDays.closedToDeparture,
      })
      .from(inventoryDays)
      .where(and(eq(inventoryDays.roomTypeId, roomTypeId), inArray(inventoryDays.date, [...dates])))
      // ORDER BY before FOR UPDATE: locks are acquired in a deterministic
      // order, so overlapping bookings queue instead of deadlocking.
      .orderBy(inventoryDays.date)
      .for('update');

    return rows.map(toDomain);
  }

  async findRange(
    tx: Executor,
    propertyId: string,
    roomTypeIds: readonly string[],
    from: IsoDate,
    toExclusive: IsoDate,
  ): Promise<InventoryDay[]> {
    const conditions = [
      eq(inventoryDays.propertyId, propertyId),
      gte(inventoryDays.date, from),
      lt(inventoryDays.date, toExclusive),
    ];
    if (roomTypeIds.length > 0) {
      conditions.push(inArray(inventoryDays.roomTypeId, [...roomTypeIds]));
    }

    const rows = await tx
      .select({
        roomTypeId: inventoryDays.roomTypeId,
        date: inventoryDays.date,
        allotment: inventoryDays.allotment,
        booked: inventoryDays.booked,
        stopSell: inventoryDays.stopSell,
        minStay: inventoryDays.minStay,
        maxStay: inventoryDays.maxStay,
        closedToArrival: inventoryDays.closedToArrival,
        closedToDeparture: inventoryDays.closedToDeparture,
      })
      .from(inventoryDays)
      .where(and(...conditions))
      .orderBy(inventoryDays.roomTypeId, inventoryDays.date);

    return rows.map(toDomain);
  }

  /**
   * The guarded increment (docs/database.md §11.1).
   *
   * `booked + units <= allotment` in the WHERE clause is the overbooking
   * guard: a night without capacity simply does not match, so the affected
   * row count comes up short and the caller rolls back.
   */
  async hold(
    tx: Executor,
    roomTypeId: string,
    dates: readonly IsoDate[],
    units: number,
  ): Promise<number> {
    if (dates.length === 0) return 0;

    const result = await tx
      .update(inventoryDays)
      .set({
        booked: sql`${inventoryDays.booked} + ${units}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryDays.roomTypeId, roomTypeId),
          inArray(inventoryDays.date, [...dates]),
          // The overbooking guard. A night without capacity simply does not
          // match, so the affected row count comes up short.
          sql`${inventoryDays.booked} + ${units} <= ${inventoryDays.allotment}`,
        ),
      );

    return result.rowCount ?? 0;
  }

  /**
   * Guarded decrement. `booked - units >= 0` prevents a double release from
   * driving the count negative and manufacturing availability that does not
   * exist.
   */
  async release(
    tx: Executor,
    roomTypeId: string,
    dates: readonly IsoDate[],
    units: number,
  ): Promise<number> {
    if (dates.length === 0) return 0;

    const result = await tx
      .update(inventoryDays)
      .set({
        booked: sql`${inventoryDays.booked} - ${units}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryDays.roomTypeId, roomTypeId),
          inArray(inventoryDays.date, [...dates]),
          // Stops a double release from driving the count negative and
          // manufacturing availability that does not exist.
          sql`${inventoryDays.booked} - ${units} >= 0`,
        ),
      );

    return result.rowCount ?? 0;
  }
}
