import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { reservations as reservationsTable } from '../../../database/schema';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { assertTransition, type ReservationStatus } from '../domain/reservation-status';

export interface UndoCheckInInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
  readonly note?: string;
}

export interface UndoCheckInResult {
  readonly id: string;
  readonly status: 'CONFIRMED';
  readonly version: number;
}

/**
 * Take a booking back from CHECKED_IN to CONFIRMED — the check-in button was
 * pressed on the wrong row.
 *
 * Check-in writes only the status and `checked_in_at` (no rooms, nights,
 * housekeeping or folio change), so reversing it writes only those two. The
 * room assignment is kept: the desk assigned it on purpose before arrival.
 */
@Injectable()
export class UndoCheckInUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UndoCheckInInput, actor: AuditActor): Promise<UndoCheckInResult> {
    const tenant = requireTenant();

    const reservation = await this.reservations.findById(this.db, input.reservationId);
    if (!reservation || reservation.propertyId !== input.propertyId) {
      throw errors.notFound('Reservation', input.reservationId);
    }

    assertTransition(reservation.status as ReservationStatus, 'CONFIRMED');
    // CHECKED_IN -> CONFIRMED is the only edge into CONFIRMED that this use case
    // may take; PENDING -> CONFIRMED is the confirm endpoint's job.
    if (reservation.status !== 'CHECKED_IN') {
      throw errors.invalidTransition(reservation.status, 'CONFIRMED');
    }

    const [timestamps] = await this.db
      .select({ checkedInAt: reservationsTable.checkedInAt })
      .from(reservationsTable)
      .where(
        and(
          eq(reservationsTable.organizationId, tenant.organizationId),
          eq(reservationsTable.id, reservation.id),
        ),
      );
    const previousCheckedInAt = timestamps?.checkedInAt ?? null;

    return this.db.transaction(async (tx) => {
      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'CONFIRMED',
        { clearCheckedInAt: true },
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'reservation.check_in_undone',
        entityType: 'reservation',
        entityId: reservation.id,
        before: {
          status: reservation.status,
          checkedInAt: previousCheckedInAt?.toISOString() ?? null,
        },
        after: { status: 'CONFIRMED', note: input.note ?? null },
      });

      return {
        id: reservation.id,
        status: 'CONFIRMED' as const,
        version: input.expectedVersion + 1,
      };
    });
  }
}
