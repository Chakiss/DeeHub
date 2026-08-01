import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';

/**
 * How far ahead a snapshot reaches.
 *
 * A year plus a little. Pickup for a stay date eighteen months out is a number
 * nobody in a small hotel acts on, and every extra day is a row per room type
 * per day forever.
 */
const HORIZON_DAYS = 400;

/**
 * How long snapshots are kept.
 *
 * Long enough to compare this year against last, which is the one comparison
 * that needs old baselines. Beyond that they are storage nobody reads.
 */
const RETENTION_DAYS = 800;

export interface CaptureResult {
  readonly propertiesCaptured: number;
  readonly rowsWritten: number;
  readonly rowsPurged: number;
}

/**
 * Freeze what is on the books, once per property per business date.
 *
 * The whole thing is one statement per property rather than a read-then-write
 * loop, because it is a projection of rows the database already holds and
 * pulling half a million of them into Node to add them up would be absurd.
 *
 * **Idempotent by construction.** The maintenance job runs every ten minutes;
 * this is meant to leave one row per stay date per business date whichever run
 * it happens on. `ON CONFLICT DO UPDATE` means the last run of the day wins,
 * so the snapshot for today keeps moving until the day ends and then stops —
 * which is the correct meaning of "on the books as of that date".
 *
 * Statuses match `GetPerformanceQuery` exactly. Two reports on the same screen
 * that count "sold" differently is how an operator learns to trust neither.
 */
@Injectable()
export class CaptureOtbSnapshotUseCase {
  private readonly logger = new Logger(CaptureOtbSnapshotUseCase.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(): Promise<CaptureResult> {
    /*
     * Deliberately NOT organization-scoped: this runs as the maintenance job,
     * outside any request, and must cover every tenant. The scoping that a
     * request would apply is replaced by the fact that nothing here takes
     * input — there is no id a caller could supply to reach another tenant.
     */
    const written = await this.db.execute<{ property_id: string }>(sql`
      INSERT INTO otb_snapshots
        (organization_id, property_id, as_of, room_type_id, stay_date, rooms_sold, revenue_minor)
      SELECT n.organization_id,
             n.property_id,
             -- Today in the PROPERTY's timezone. A snapshot taken at 00:30 in
             -- Bangkok belongs to that day, and a UTC date would file it under
             -- the previous one.
             (now() AT TIME ZONE p.timezone)::date AS as_of,
             n.room_type_id,
             n.date AS stay_date,
             count(*)::int AS rooms_sold,
             coalesce(sum(n.amount_minor), 0)::bigint AS revenue_minor
        FROM reservation_stay_nights n
        JOIN reservations r ON r.id = n.reservation_id
        JOIN properties p ON p.id = n.property_id
       WHERE r.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
         -- Stay dates from today forward only. Pickup is about business still
         -- to come; a night already past cannot be picked up.
         AND n.date >= (now() AT TIME ZONE p.timezone)::date
         AND n.date < (now() AT TIME ZONE p.timezone)::date
                      + make_interval(days => ${HORIZON_DAYS})
       GROUP BY n.organization_id, n.property_id, as_of, n.room_type_id, n.date
      ON CONFLICT (property_id, as_of, room_type_id, stay_date) DO UPDATE
        SET rooms_sold = EXCLUDED.rooms_sold,
            revenue_minor = EXCLUDED.revenue_minor
      RETURNING property_id
    `);

    /*
     * A stay date that had bookings this morning and none now writes no row
     * above — the GROUP BY has nothing to group. Left alone, this morning's row
     * would survive and the report would show business that has since been
     * cancelled as still on the books. Delete today's rows that the insert did
     * not just touch.
     */
    const cleared = await this.db.execute(sql`
      DELETE FROM otb_snapshots s
       USING properties p
       WHERE p.id = s.property_id
         AND s.as_of = (now() AT TIME ZONE p.timezone)::date
         AND NOT EXISTS (
           SELECT 1
             FROM reservation_stay_nights n
             JOIN reservations r ON r.id = n.reservation_id
            WHERE n.room_type_id = s.room_type_id
              AND n.date = s.stay_date
              AND r.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
         )
    `);

    const purged = await this.db.execute(sql`
      DELETE FROM otb_snapshots s
       USING properties p
       WHERE p.id = s.property_id
         AND s.as_of < (now() AT TIME ZONE p.timezone)::date
                       - make_interval(days => ${RETENTION_DAYS})
    `);

    const properties = new Set(written.rows.map((row) => row.property_id));
    const result = {
      propertiesCaptured: properties.size,
      rowsWritten: written.rows.length,
      rowsPurged: (purged.rowCount ?? 0) + (cleared.rowCount ?? 0),
    };

    if (result.rowsWritten > 0 || result.rowsPurged > 0) {
      this.logger.log(
        `On-the-books: ${String(result.rowsWritten)} row(s) across ` +
          `${String(result.propertiesCaptured)} propert(ies), ${String(result.rowsPurged)} removed`,
      );
    }

    return result;
  }
}
