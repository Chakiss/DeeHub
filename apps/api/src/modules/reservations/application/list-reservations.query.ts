import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { errors, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { reservationStays, reservations } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';

export interface ListReservationsFilter {
  readonly propertyId: string;
  readonly status?: readonly string[];
  readonly checkInFrom?: IsoDate;
  readonly checkInTo?: IsoDate;
  readonly channelId?: string;
  readonly source?: string;
  /** Free text over code, guest name, email and phone. */
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReservationListItem {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly source: string;
  readonly bookerName: string;
  readonly checkIn: string | null;
  readonly checkOut: string | null;
  readonly nights: number;
  readonly rooms: number;
  readonly total: { amount: number; currency: string };
  readonly createdAt: string;
}

export interface ReservationList {
  readonly items: readonly ReservationListItem[];
  readonly pageInfo: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Reservation list for the dashboard (api-spec.md §6.6).
 *
 * KEYSET pagination on (created_at, id), not OFFSET. A busy property receives
 * bookings while staff are paging; with an offset, every new arrival shifts the
 * window and rows get skipped or shown twice. A cursor is stable under
 * concurrent inserts.
 */
@Injectable()
export class ListReservationsQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(filter: ListReservationsFilter): Promise<ReservationList> {
    const organizationId = requireOrganizationId();
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const conditions: SQL[] = [
      eq(reservations.organizationId, organizationId),
      eq(reservations.propertyId, filter.propertyId),
    ];

    if (filter.status && filter.status.length > 0) {
      conditions.push(
        sql`${reservations.status} IN (${sql.join(
          filter.status.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      );
    }
    if (filter.channelId) conditions.push(eq(reservations.channelId, filter.channelId));
    if (filter.source) conditions.push(eq(reservations.source, filter.source));

    if (filter.q) {
      const term = `%${filter.q}%`;
      const search = or(
        ilike(reservations.code, term),
        ilike(reservations.bookerName, term),
        ilike(reservations.bookerEmail, term),
        ilike(reservations.bookerPhone, term),
      );
      if (search) conditions.push(search);
    }

    // Arrival-window filters are a property of the stay, so they are applied as
    // an EXISTS rather than a join — a reservation with two stays must appear
    // once, not twice.
    if (filter.checkInFrom || filter.checkInTo) {
      const stayConditions: SQL[] = [eq(reservationStays.reservationId, reservations.id)];
      if (filter.checkInFrom) {
        stayConditions.push(gte(reservationStays.checkIn, filter.checkInFrom));
      }
      if (filter.checkInTo) {
        stayConditions.push(lte(reservationStays.checkIn, filter.checkInTo));
      }
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${reservationStays} WHERE ${and(...stayConditions)})`,
      );
      // (This one is safe: it uses drizzle column references on both sides, so
      // both are rendered and neither is shadowed by an alias.)
    }

    if (filter.cursor) {
      const decoded = this.decodeCursor(filter.cursor);
      conditions.push(
        sql`(${reservations.createdAt}, ${reservations.id}) < (${decoded.createdAt}, ${decoded.id})`,
      );
    }

    // One extra row tells us whether another page exists without a count query.
    const rows = await this.db
      .select({
        id: reservations.id,
        code: reservations.code,
        status: reservations.status,
        source: reservations.source,
        bookerName: reservations.bookerName,
        totalMinor: reservations.totalMinor,
        currency: reservations.currency,
        createdAt: reservations.createdAt,
        // The outer column is written FULLY QUALIFIED on purpose. Drizzle
        // renders an embedded column reference as a bare "id", and inside these
        // subqueries `reservation_stays` also has an `id`, so the inner scope
        // wins and the correlation silently becomes `s.reservation_id = s.id` —
        // always false, so every row reports zero rooms and no dates.
        checkIn: sql<string | null>`(
          SELECT MIN(s.check_in)::text FROM reservation_stays s
           WHERE s.reservation_id = "reservations"."id"
        )`,
        checkOut: sql<string | null>`(
          SELECT MAX(s.check_out)::text FROM reservation_stays s
           WHERE s.reservation_id = "reservations"."id"
        )`,
        rooms: sql<number>`(
          SELECT COUNT(*)::int FROM reservation_stays s
           WHERE s.reservation_id = "reservations"."id"
        )`,
        nights: sql<number>`(
          SELECT COUNT(DISTINCT n.date)::int FROM reservation_stay_nights n
           WHERE n.reservation_id = "reservations"."id"
        )`,
      })
      .from(reservations)
      .where(and(...conditions))
      .orderBy(desc(reservations.createdAt), desc(reservations.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        code: row.code,
        status: row.status,
        source: row.source,
        bookerName: row.bookerName,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        nights: row.nights,
        rooms: row.rooms,
        total: { amount: row.totalMinor, currency: row.currency },
        createdAt: row.createdAt.toISOString(),
      })),
      pageInfo: {
        nextCursor: hasMore && last ? this.encodeCursor(last.createdAt, last.id) : null,
        hasMore,
      },
    };
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        c?: string;
        i?: string;
      };
      if (!parsed.c || !parsed.i) throw new Error('incomplete cursor');
      return { createdAt: parsed.c, id: parsed.i };
    } catch {
      // A malformed cursor is client error, not a 500.
      throw errors.validation('Invalid pagination cursor');
    }
  }
}
