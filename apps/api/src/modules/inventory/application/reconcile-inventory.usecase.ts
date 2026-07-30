import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';

export interface InventoryDrift {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly date: string;
  /** What `inventory_days.booked` says. */
  readonly actual: number;
  /** What the inventory-holding reservations add up to. */
  readonly expected: number;
}

export interface ReconciliationResult {
  readonly checked: number;
  readonly drift: readonly InventoryDrift[];
}

/**
 * Verifies `inventory_days.booked` against the reservations that reference it
 * (ADR-0002, docs/database.md §11.3).
 *
 * This job REPORTS and never repairs. Drift means a bug in the booking or
 * release path, and silently correcting the number would hide the defect while
 * leaving the cause in place — the next occurrence would be an overbooking
 * nobody saw coming. An alert with the exact rows is the useful outcome.
 */
@Injectable()
export class ReconcileInventoryUseCase {
  private readonly logger = new Logger(ReconcileInventoryUseCase.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Checks from yesterday forward; past nights are history and cannot change. */
  async execute(): Promise<ReconciliationResult> {
    const result = await this.db.execute<{
      property_id: string;
      room_type_id: string;
      date: string;
      actual: number;
      expected: number;
    }>(sql`
      WITH expected AS (
        SELECT n.room_type_id, n.date, COUNT(*)::int AS booked
          FROM reservation_stay_nights n
          JOIN reservations r ON r.id = n.reservation_id
         WHERE r.status IN ('PENDING','CONFIRMED','CHECKED_IN','CHECKED_OUT')
           AND n.date >= current_date - 1
         GROUP BY n.room_type_id, n.date
      )
      SELECT i.property_id,
             i.room_type_id,
             i.date::text AS date,
             i.booked AS actual,
             COALESCE(e.booked, 0) AS expected
        FROM inventory_days i
        LEFT JOIN expected e
               ON e.room_type_id = i.room_type_id AND e.date = i.date
       WHERE i.date >= current_date - 1
         AND i.booked IS DISTINCT FROM COALESCE(e.booked, 0)
       ORDER BY i.property_id, i.room_type_id, i.date
       LIMIT 500
    `);

    const counted = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM inventory_days WHERE date >= current_date - 1
    `);

    const drift: InventoryDrift[] = result.rows.map((row) => ({
      propertyId: row.property_id,
      roomTypeId: row.room_type_id,
      date: row.date,
      actual: Number(row.actual),
      expected: Number(row.expected),
    }));

    if (drift.length > 0) {
      // Loud on purpose. This should never fire; if it does, the booking path
      // has a bug and someone needs to look today.
      this.logger.error(
        `INVENTORY DRIFT DETECTED on ${String(drift.length)} night(s). ` +
          `First: room type ${drift[0]?.roomTypeId ?? '?'} on ${drift[0]?.date ?? '?'} ` +
          `has booked=${String(drift[0]?.actual)} but reservations imply ${String(drift[0]?.expected)}.`,
      );
    }

    return { checked: Number(counted.rows[0]?.count ?? 0), drift };
  }
}
