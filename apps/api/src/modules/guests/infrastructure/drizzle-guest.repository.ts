import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { guests } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  CreateGuestRecord,
  GuestRecord,
  GuestRepository,
  GuestSummary,
} from '../domain/guest.repository';

const COLUMNS = {
  id: guests.id,
  firstName: guests.firstName,
  lastName: guests.lastName,
  email: guests.email,
  phone: guests.phone,
  nationality: guests.nationality,
  notes: guests.notes,
};

/**
 * Stay counts come from reservations, which this module does not own.
 *
 * Read as a correlated aggregate rather than by reaching into the reservations
 * module's logic: it is one number per row on a list screen, and routing it
 * through a port would mean N queries or a second round trip for a figure the
 * database can produce in the same scan. Cancelled bookings are excluded —
 * somebody who booked and cancelled is not a returning guest.
 *
 * The outer columns are written as raw qualified identifiers, NOT as embedded
 * Drizzle columns. Embedding renders a bare `"id"`, which inside a correlated
 * subquery resolves against the SUBQUERY's table — so `r.guest_id = "id"`
 * silently compares a reservation to itself and every count comes back wrong
 * without any error. The same trap cost a debugging session on the reservation
 * list query.
 */
const STAY_STATS = {
  stays: sql<number>`(
    SELECT count(*)::int FROM reservations r
     WHERE r.guest_id = "guests"."id" AND r.status <> 'CANCELLED'
  )`,
  lastStay: sql<string | null>`(
    SELECT max(s.check_in)::text FROM reservations r
      JOIN reservation_stays s ON s.reservation_id = r.id
     WHERE r.guest_id = "guests"."id" AND r.status <> 'CANCELLED'
  )`,
  revenueMinor: sql<number>`(
    SELECT coalesce(sum(n.amount_minor), 0)::bigint FROM reservations r
      JOIN reservation_stay_nights n ON n.reservation_id = r.id
     WHERE r.guest_id = "guests"."id" AND r.status <> 'CANCELLED'
  )`,
  possibleDuplicates: sql<number>`(
    SELECT count(*)::int FROM guests g2
     WHERE g2.organization_id = "guests"."organization_id"
       AND g2.id <> "guests"."id"
       AND g2.email IS NOT NULL
       AND lower(g2.email) = lower("guests"."email")
  )`,
};

@Injectable()
export class DrizzleGuestRepository implements GuestRepository {
  async findMatch(
    tx: Executor,
    email: string | null,
    lastName: string | null,
  ): Promise<GuestRecord | null> {
    // Both are required to match. Without a last name there is nothing to
    // distinguish two people sharing an address, so a new profile is correct.
    if (!email || !lastName) return null;

    const rows = await tx
      .select(COLUMNS)
      .from(guests)
      .where(
        and(
          eq(guests.organizationId, requireOrganizationId()),
          sql`lower(${guests.email}) = lower(${email})`,
          sql`lower(${guests.lastName}) = lower(${lastName})`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async insert(tx: Executor, record: CreateGuestRecord): Promise<void> {
    await tx.insert(guests).values(record);
  }

  async findById(tx: Executor, guestId: string): Promise<GuestSummary | null> {
    const rows = await tx
      .select({ ...COLUMNS, ...STAY_STATS })
      .from(guests)
      .where(and(eq(guests.organizationId, requireOrganizationId()), eq(guests.id, guestId)))
      .limit(1);

    return rows[0] ? normalize(rows[0]) : null;
  }

  async search(
    tx: Executor,
    propertyId: string,
    term: string | null,
    limit: number,
  ): Promise<readonly GuestSummary[]> {
    const conditions = [
      eq(guests.organizationId, requireOrganizationId()),
      // Guests of THIS hotel. The profile spans the group; the list does not.
      sql`EXISTS (
        SELECT 1 FROM reservations r
         WHERE r.guest_id = "guests"."id" AND r.property_id = ${propertyId}
      )`,
    ];

    if (term) {
      const pattern = `%${term.trim().toLowerCase()}%`;
      conditions.push(
        sql`(
          lower(${guests.firstName}) LIKE ${pattern}
          OR lower(coalesce(${guests.lastName}, '')) LIKE ${pattern}
          OR lower(coalesce(${guests.email}, '')) LIKE ${pattern}
          OR coalesce(${guests.phone}, '') LIKE ${pattern}
        )`,
      );
    }

    const rows = await tx
      .select({ ...COLUMNS, ...STAY_STATS })
      .from(guests)
      .where(and(...conditions))
      // Most recent guest first: a front desk is looking for someone who was
      // just here far more often than for someone from two years ago.
      .orderBy(sql`${guests.createdAt} DESC`)
      .limit(limit);

    return rows.map(normalize);
  }

  async update(
    tx: Executor,
    guestId: string,
    fields: Partial<Pick<GuestRecord, 'firstName' | 'lastName' | 'email' | 'phone' | 'notes'>>,
  ): Promise<void> {
    await tx
      .update(guests)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(guests.organizationId, requireOrganizationId()), eq(guests.id, guestId)));
  }
}

/** pg returns bigint aggregates as strings; the counts must be numbers. */
function normalize(row: Record<string, unknown>): GuestSummary {
  return {
    ...(row as unknown as GuestSummary),
    stays: Number(row['stays'] ?? 0),
    revenueMinor: Number(row['revenueMinor'] ?? 0),
    possibleDuplicates: Number(row['possibleDuplicates'] ?? 0),
  };
}
