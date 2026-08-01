import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { dateRange, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { otbSnapshots, reservationStayNights, reservations } from '../../../database/schema';

/** The same set the performance report counts as sold. */
const SOLD_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const;

export interface PickupNight {
  readonly date: IsoDate;
  /** On the books right now — the same number the performance report shows. */
  readonly roomsSold: number;
  readonly revenueMinor: number;
  /** On the books as of the baseline. Null when there is no baseline at all. */
  readonly baselineRoomsSold: number | null;
  readonly baselineRevenueMinor: number | null;
  /** What was taken since. Negative means net cancellations. */
  readonly pickupRooms: number | null;
  readonly pickupRevenueMinor: number | null;
}

export interface Pickup {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly currency: string;
  /** The baseline the caller asked for. */
  readonly asOfRequested: IsoDate;
  /**
   * The baseline actually used — the most recent snapshot on or before the
   * requested date. Null when none exists yet.
   *
   * Reported rather than hidden: if the maintenance job missed three days, the
   * comparison silently spans ten days instead of seven, and a revenue manager
   * reading "pickup over the last week" would be reading something else.
   */
  readonly asOfUsed: IsoDate | null;
  /** When history begins, so a caller with no baseline can say why. */
  readonly earliestSnapshot: IsoDate | null;
  readonly nights: readonly PickupNight[];
  readonly totals: {
    readonly roomsSold: number;
    readonly revenueMinor: number;
    readonly baselineRoomsSold: number | null;
    readonly baselineRevenueMinor: number | null;
    readonly pickupRooms: number | null;
    readonly pickupRevenueMinor: number | null;
  };
}

/**
 * Pickup: how much business arrived for a stay date since a past business date
 * (roadmap Phase 4).
 *
 * Two different kinds of number, deliberately read two different ways.
 *
 * **Now is live**, computed from reservations exactly as the performance report
 * computes it. Reading it from today's snapshot instead would be cheaper and
 * would show a figure up to ten minutes stale next to a booking the clerk just
 * took — and the first time those disagree, both reports stop being believed.
 *
 * **Then is a snapshot**, because nothing in the live data remembers what it
 * looked like last Tuesday. See `otb_snapshots`.
 *
 * Pickup can be NEGATIVE, and that is not an error condition: a week with more
 * cancellations than bookings is exactly the week somebody needs to see.
 */
@Injectable()
export class GetPickupQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(
    propertyId: string,
    from: IsoDate,
    to: IsoDate,
    asOfRequested: IsoDate,
  ): Promise<Pickup> {
    const organizationId = requireOrganizationId();

    // One baseline date for the whole window, not one per stay date: a capture
    // writes every stay date at once, so a stay date missing from that day's
    // rows had nothing on the books rather than no snapshot.
    const [baselineRow] = await this.db
      .select({
        asOf: sql<string | null>`max(${otbSnapshots.asOf})`,
        earliest: sql<string | null>`min(${otbSnapshots.asOf})`,
      })
      .from(otbSnapshots)
      .where(
        and(
          eq(otbSnapshots.organizationId, organizationId),
          eq(otbSnapshots.propertyId, propertyId),
        ),
      );

    const earliestSnapshot = baselineRow?.earliest ? toIsoDate(baselineRow.earliest) : null;

    const [usedRow] = await this.db
      .select({ asOf: sql<string | null>`max(${otbSnapshots.asOf})` })
      .from(otbSnapshots)
      .where(
        and(
          eq(otbSnapshots.organizationId, organizationId),
          eq(otbSnapshots.propertyId, propertyId),
          lte(otbSnapshots.asOf, asOfRequested),
        ),
      );

    const asOfUsed = usedRow?.asOf ? toIsoDate(usedRow.asOf) : null;

    const [live, baseline] = await Promise.all([
      this.db
        .select({
          date: reservationStayNights.date,
          roomsSold: sql<number>`count(*)::int`,
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

      asOfUsed === null
        ? Promise.resolve([])
        : this.db
            .select({
              date: otbSnapshots.stayDate,
              roomsSold: sql<number>`coalesce(sum(${otbSnapshots.roomsSold}), 0)::int`,
              revenueMinor: sql<number>`coalesce(sum(${otbSnapshots.revenueMinor}), 0)::bigint`,
            })
            .from(otbSnapshots)
            .where(
              and(
                eq(otbSnapshots.organizationId, organizationId),
                eq(otbSnapshots.propertyId, propertyId),
                eq(otbSnapshots.asOf, asOfUsed),
                gte(otbSnapshots.stayDate, from),
                lt(otbSnapshots.stayDate, to),
              ),
            )
            .groupBy(otbSnapshots.stayDate),
    ]);

    const liveByDate = new Map(live.map((row) => [toIsoDate(row.date), row]));
    const baseByDate = new Map(baseline.map((row) => [toIsoDate(row.date), row]));

    const nights: PickupNight[] = dateRange(from, to).map((date) => {
      const now = liveByDate.get(date);
      const roomsSold = Number(now?.roomsSold ?? 0);
      const revenueMinor = Number(now?.revenueMinor ?? 0);

      if (asOfUsed === null) {
        return {
          date,
          roomsSold,
          revenueMinor,
          baselineRoomsSold: null,
          baselineRevenueMinor: null,
          pickupRooms: null,
          pickupRevenueMinor: null,
        };
      }

      // Absent from the baseline means nothing was on the books that day, not
      // that the day is unknown — the capture writes every stay date at once.
      const then = baseByDate.get(date);
      const baselineRoomsSold = Number(then?.roomsSold ?? 0);
      const baselineRevenueMinor = Number(then?.revenueMinor ?? 0);

      return {
        date,
        roomsSold,
        revenueMinor,
        baselineRoomsSold,
        baselineRevenueMinor,
        pickupRooms: roomsSold - baselineRoomsSold,
        pickupRevenueMinor: revenueMinor - baselineRevenueMinor,
      };
    });

    const sum = (pick: (night: PickupNight) => number | null): number | null =>
      nights.reduce<number | null>((total, night) => {
        const value = pick(night);
        return total === null || value === null ? null : total + value;
      }, 0);

    return {
      from,
      to,
      currency: live[0]?.currency ?? 'THB',
      asOfRequested,
      asOfUsed,
      earliestSnapshot,
      nights,
      totals: {
        roomsSold: nights.reduce((total, night) => total + night.roomsSold, 0),
        revenueMinor: nights.reduce((total, night) => total + night.revenueMinor, 0),
        baselineRoomsSold: sum((night) => night.baselineRoomsSold),
        baselineRevenueMinor: sum((night) => night.baselineRevenueMinor),
        pickupRooms: sum((night) => night.pickupRooms),
        pickupRevenueMinor: sum((night) => night.pickupRevenueMinor),
      },
    };
  }
}
