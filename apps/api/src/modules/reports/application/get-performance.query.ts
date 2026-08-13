import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { dateRange, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  inventoryDays,
  physicalRooms,
  reservationStayNights,
  reservations,
} from '../../../database/schema';

export interface PerformanceNight {
  readonly date: IsoDate;
  readonly roomsSold: number;
  readonly revenueMinor: number;
  /** What the property offered for sale that night. */
  readonly allotment: number;
  /** Revenue per room sold. Null when nothing sold — an average of nothing. */
  readonly adrMinor: number | null;
  /** Sold over offered. The channel-manager question. */
  readonly sellThrough: number | null;
  /** Sold over physical rooms. The hotel-industry question. */
  readonly occupancy: number | null;
  /** Revenue per available room, the industry definition. */
  readonly revParMinor: number | null;
}

export interface Performance {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly currency: string;
  /** Active rooms, or null when none are set up — see the note below. */
  readonly roomsAvailable: number | null;
  readonly nights: readonly PerformanceNight[];
  readonly totals: {
    readonly roomsSold: number;
    readonly revenueMinor: number;
    readonly allotment: number;
    readonly adrMinor: number | null;
    readonly sellThrough: number | null;
    readonly occupancy: number | null;
    readonly revParMinor: number | null;
  };
}

/**
 * Statuses that count as sold.
 *
 * The SAME set the inventory grid counts as booked. Industry revenue reports
 * often exclude unconfirmed holds, but a report that disagreed with the grid on
 * the same screen-refresh would make an operator distrust both — and the grid
 * is the number they act on.
 */
const SOLD_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const;

/**
 * Occupancy, ADR and RevPAR (roadmap Phase 4).
 *
 * Reports BOTH denominators on purpose, and this is the decision worth
 * understanding.
 *
 * "Occupancy" in the hotel industry is rooms sold over PHYSICAL rooms
 * available, and that is the number an owner compares against an STR report or
 * their previous PMS. But this system sells ALLOTMENT — a commercial decision
 * that is deliberately independent of how many keys exist (ADR-0002) — and a
 * property can run without entering a single physical room.
 *
 * Publishing one figure and calling it occupancy would therefore be wrong for
 * somebody either way, and the first time an owner finds a number that does not
 * match their own they stop believing every other number on the page. So
 * `occupancy` and `revPar` use physical rooms and are NULL until rooms exist,
 * while `sellThrough` answers "how much of what I offered did I sell" and is
 * always computable. ADR needs no denominator choice at all.
 *
 * One approximation is unavoidable: the room count is today's. Applied to past
 * dates it assumes the hotel had the same rooms then, because no history of
 * room additions is kept.
 */
@Injectable()
export class GetPerformanceQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(propertyId: string, from: IsoDate, to: IsoDate): Promise<Performance> {
    const organizationId = requireOrganizationId();

    const [sold, offered, rooms] = await Promise.all([
      this.db
        .select({
          date: reservationStayNights.date,
          /*
           * Nights the guest paid for but did not occupy are counted OUT of
           * rooms sold and left IN revenue, and the split is the point.
           *
           * A guest leaves at six, the room goes back on sale, somebody else
           * takes it at eight. One room was occupied; two nights were sold.
           * Counting both as rooms sold reports 200% occupancy on a property
           * with one bungalow. Dropping the first one's money instead would
           * hide revenue the hotel genuinely earned — and make ADR read as if
           * the room went for half what it did.
           *
           * See docs/early-checkout-plan.md.
           */
          roomsSold: sql<number>`count(*) filter (where not ${reservationStayNights.releasedEarly})::int`,
          revenueMinor: sql<number>`coalesce(sum(${reservationStayNights.amountMinor}), 0)::bigint`,
          currency: sql<string>`min(${reservationStayNights.currency})`,
        })
        .from(reservationStayNights)
        .innerJoin(reservations, eq(reservations.id, reservationStayNights.reservationId))
        .where(
          and(
            eq(reservationStayNights.organizationId, organizationId),
            eq(reservationStayNights.propertyId, propertyId),
            gte(reservationStayNights.date, from),
            lt(reservationStayNights.date, to),
            inArray(reservations.status, [...SOLD_STATUSES]),
          ),
        )
        .groupBy(reservationStayNights.date),

      this.db
        .select({
          date: inventoryDays.date,
          allotment: sql<number>`coalesce(sum(${inventoryDays.allotment}), 0)::int`,
        })
        .from(inventoryDays)
        .where(
          and(
            eq(inventoryDays.organizationId, organizationId),
            eq(inventoryDays.propertyId, propertyId),
            gte(inventoryDays.date, from),
            lt(inventoryDays.date, to),
          ),
        )
        .groupBy(inventoryDays.date),

      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(physicalRooms)
        .where(
          and(
            eq(physicalRooms.organizationId, organizationId),
            eq(physicalRooms.propertyId, propertyId),
            eq(physicalRooms.isActive, true),
          ),
        ),
    ]);

    const soldByDate = new Map(sold.map((row) => [toIsoDate(row.date), row]));
    const offeredByDate = new Map(offered.map((row) => [toIsoDate(row.date), row.allotment]));

    const roomsAvailable = rooms[0]?.count ?? 0;
    // Zero rooms is "not set up", not "a hotel with no rooms". Reporting 0 would
    // make every occupancy figure divide by zero or read as 0%.
    const roomsOrNull = roomsAvailable > 0 ? roomsAvailable : null;

    const nights = dateRange(from, to).map((date) => {
      const row = soldByDate.get(date);
      const roomsSold = Number(row?.roomsSold ?? 0);
      const revenueMinor = Number(row?.revenueMinor ?? 0);
      const allotment = offeredByDate.get(date) ?? 0;

      return {
        date,
        roomsSold,
        revenueMinor,
        allotment,
        adrMinor: roomsSold > 0 ? Math.round(revenueMinor / roomsSold) : null,
        sellThrough: allotment > 0 ? roomsSold / allotment : null,
        occupancy: roomsOrNull ? roomsSold / roomsOrNull : null,
        revParMinor: roomsOrNull ? Math.round(revenueMinor / roomsOrNull) : null,
      };
    });

    const roomsSold = nights.reduce((sum, night) => sum + night.roomsSold, 0);
    const revenueMinor = nights.reduce((sum, night) => sum + night.revenueMinor, 0);
    const allotment = nights.reduce((sum, night) => sum + night.allotment, 0);
    // Room-nights, not rooms: a 7-night window with 10 rooms offers 70.
    const roomNightsAvailable = roomsOrNull === null ? null : roomsOrNull * nights.length;

    return {
      from,
      to,
      // A property has one currency (ADR-0003), so the first night's is it.
      currency: sold[0]?.currency ?? 'THB',
      roomsAvailable: roomsOrNull,
      nights,
      totals: {
        roomsSold,
        revenueMinor,
        allotment,
        adrMinor: roomsSold > 0 ? Math.round(revenueMinor / roomsSold) : null,
        sellThrough: allotment > 0 ? roomsSold / allotment : null,
        occupancy: roomNightsAvailable ? roomsSold / roomNightsAvailable : null,
        revParMinor: roomNightsAvailable ? Math.round(revenueMinor / roomNightsAvailable) : null,
      },
    };
  }
}
