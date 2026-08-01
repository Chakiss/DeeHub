import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { guests } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  CreateGuestRecord,
  GuestMergeRecord,
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
/**
 * What makes two profiles look like the same person, in SQL.
 *
 * Shared by the count on every row and by the candidate list, so the number
 * badge and the screen it opens can never disagree — which they would within a
 * week if this were written twice.
 *
 * The phone comparison takes the last nine digits, because Thailand writes the
 * same mobile as `081 234 5678` and as `+66 81 234 5678` and a returning guest
 * will have used both. See `phoneKey` in the domain module, which must agree.
 */
const DUPLICATE_PREDICATE = sql`
  (g2.email IS NOT NULL AND "guests"."email" IS NOT NULL
     AND lower(g2.email) = lower("guests"."email"))
  OR (length(regexp_replace(coalesce(g2.phone, ''), '\\D', '', 'g')) >= 9
     AND right(regexp_replace(coalesce(g2.phone, ''), '\\D', '', 'g'), 9)
       = right(regexp_replace(coalesce("guests"."phone", ''), '\\D', '', 'g'), 9))
  OR (g2.last_name IS NOT NULL AND "guests"."last_name" IS NOT NULL
     AND lower(g2.first_name) = lower("guests"."first_name")
     AND lower(g2.last_name) = lower("guests"."last_name"))
`;

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
       AND g2.merged_into_id IS NULL
       AND (${DUPLICATE_PREDICATE})
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
          // Never attach a new booking to a profile that has been folded into
          // another one — the stay would land on a record nothing reads.
          isNull(guests.mergedIntoId),
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
      .where(
        and(
          eq(guests.organizationId, requireOrganizationId()),
          eq(guests.id, guestId),
          // A tombstone is not a guest. Its stays now belong to the survivor,
          // so serving it would show a profile with no history and no reason.
          isNull(guests.mergedIntoId),
        ),
      )
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
      isNull(guests.mergedIntoId),
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

  async findDuplicateCandidates(
    tx: Executor,
    guestId: string,
    limit: number,
  ): Promise<readonly GuestRecord[]> {
    /*
     * Raw SQL rather than the query builder: the predicate is shared with the
     * per-row count above and refers to the subject by the alias `guests`,
     * which only holds if this reads the same way. Rewriting it in builder
     * syntax is how the badge and the list drift apart.
     */
    const result = await tx.execute<{
      id: string;
      first_name: string;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      nationality: string | null;
      notes: string | null;
    }>(sql`
      SELECT g2.id, g2.first_name, g2.last_name, g2.email, g2.phone,
             g2.nationality, g2.notes
        FROM guests g2, guests
       WHERE "guests"."id" = ${guestId}
         AND "guests"."organization_id" = ${requireOrganizationId()}
         AND g2.organization_id = "guests"."organization_id"
         AND g2.id <> "guests"."id"
         AND g2.merged_into_id IS NULL
         AND (${DUPLICATE_PREDICATE})
       ORDER BY g2.created_at DESC
       LIMIT ${limit}
    `);

    return result.rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      nationality: row.nationality,
      notes: row.notes,
    }));
  }

  async lockPairForMerge(
    tx: Executor,
    guestIdA: string,
    guestIdB: string,
  ): Promise<readonly GuestMergeRecord[]> {
    // ORDER BY id before FOR UPDATE: two transactions locking the same pair in
    // opposite orders would deadlock, and a merge is exactly the operation two
    // operators run on the same pair at the same time.
    const result = await tx.execute<{
      id: string;
      first_name: string;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      nationality: string | null;
      notes: string | null;
      document_type: string | null;
      document_number_encrypted: Buffer | null;
      date_of_birth: string | null;
      merged_into_id: string | null;
    }>(sql`
      SELECT id, first_name, last_name, email, phone, nationality, notes,
             document_type, document_number_encrypted,
             date_of_birth::text AS date_of_birth, merged_into_id
        FROM guests
       WHERE organization_id = ${requireOrganizationId()}
         AND id IN (${guestIdA}, ${guestIdB})
       ORDER BY id
         FOR UPDATE
    `);

    return result.rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      nationality: row.nationality,
      notes: row.notes,
      documentType: row.document_type,
      documentNumberEncrypted: row.document_number_encrypted,
      dateOfBirth: row.date_of_birth,
      mergedIntoId: row.merged_into_id,
    }));
  }

  async applyMergedFields(
    tx: Executor,
    guestId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await tx
      .update(guests)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(guests.organizationId, requireOrganizationId()), eq(guests.id, guestId)));
  }

  async reassignReservations(
    tx: Executor,
    fromGuestId: string,
    toGuestId: string,
  ): Promise<readonly string[]> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE reservations
         SET guest_id = ${toGuestId}, updated_at = now()
       WHERE organization_id = ${requireOrganizationId()}
         AND guest_id = ${fromGuestId}
      RETURNING id
    `);
    return result.rows.map((row) => row.id);
  }

  async markMerged(tx: Executor, guestId: string, intoGuestId: string, at: Date): Promise<void> {
    await tx
      .update(guests)
      .set({ mergedIntoId: intoGuestId, mergedAt: at, updatedAt: at })
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
