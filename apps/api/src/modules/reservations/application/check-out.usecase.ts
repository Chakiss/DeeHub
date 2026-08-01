import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { physicalRooms, reservationStays } from '../../../database/schema';
import { GetFolioQuery } from '../../folio/application/get-folio.query';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { assertTransition, type ReservationStatus } from '../domain/reservation-status';

export interface CheckOutInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
}

export interface CheckOutResult {
  readonly id: string;
  readonly status: 'CHECKED_OUT';
  readonly checkedOutAt: Date;
  /** Rooms handed to housekeeping. */
  readonly roomsToClean: readonly string[];
  /**
   * What the guest still owes, in minor units. Negative means the hotel owes
   * them. Reported, never enforced — see below.
   */
  readonly outstandingBalance: number;
  readonly currency: string;
}

/**
 * Check a booking out.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not release inventory. The guest occupied those nights; giving them
 * back would make historical occupancy lie and, worse, let the room be resold
 * for a date already past (reservation-status.ts keeps CHECKED_OUT holding).
 *
 * It does not clear the room assignment. Which room someone stayed in is the
 * answer to "who was in 302 last Tuesday" — a question hotels genuinely ask.
 * The exclusion constraint is on date ranges, so a past stay blocks nothing.
 *
 * It also does not REFUSE an unpaid balance, and that is a third deliberate
 * omission rather than an oversight. Plenty of departures are legitimately
 * unsettled here: an OTA has already collected, a company is billed monthly, a
 * card is charged after the minibar is checked. Blocking check-out on a
 * non-zero balance would stop a guest leaving over a bill the hotel never
 * intended to collect at the desk. So the balance is RETURNED, the screen puts
 * it in front of whoever is standing there, and the decision stays with them.
 */
@Injectable()
export class CheckOutUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly folio: GetFolioQuery,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CheckOutInput, actor: AuditActor): Promise<CheckOutResult> {
    const tenant = requireTenant();

    const reservation = await this.reservations.findById(this.db, input.reservationId);
    if (!reservation || reservation.propertyId !== input.propertyId) {
      throw errors.notFound('Reservation', input.reservationId);
    }

    // Only from CHECKED_IN. Checking out a booking that never arrived is a
    // no-show, which is a different decision with different consequences.
    assertTransition(reservation.status as ReservationStatus, 'CHECKED_OUT');

    const stays = await this.db
      .select({
        assignedRoomId: reservationStays.assignedRoomId,
        roomNumber: physicalRooms.roomNumber,
      })
      .from(reservationStays)
      .leftJoin(physicalRooms, eq(physicalRooms.id, reservationStays.assignedRoomId))
      .where(
        and(
          eq(reservationStays.organizationId, tenant.organizationId),
          eq(reservationStays.reservationId, input.reservationId),
        ),
      );

    const roomIds = stays
      .map((stay) => stay.assignedRoomId)
      .filter((id): id is string => id !== null);

    const now = new Date();

    return this.db.transaction(async (tx) => {
      // Read before the status changes, and inside the transaction, so the
      // figure handed to the desk is the one that was true at the moment the
      // guest was checked out.
      const folio = await this.folio.load(tx, input.propertyId, reservation.id);
      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'CHECKED_OUT',
        { checkedOutAt: now },
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      // The housekeeping handover, and the reason check-out is worth modelling
      // rather than leaving as a status flip: a departed room needs cleaning
      // before anyone else can be put in it.
      if (roomIds.length > 0) {
        await tx
          .update(physicalRooms)
          .set({ housekeepingStatus: 'DIRTY', updatedAt: now })
          .where(
            and(
              eq(physicalRooms.organizationId, tenant.organizationId),
              inArray(physicalRooms.id, roomIds),
              // A room somebody took out of order stays out of order —
              // housekeeping owns that state, and a departure does not undo it.
              ne(physicalRooms.housekeepingStatus, 'OUT_OF_ORDER'),
            ),
          );
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'reservation.checked_out',
        entityType: 'reservation',
        entityId: reservation.id,
        before: { status: reservation.status },
        after: {
          status: 'CHECKED_OUT',
          checkedOutAt: now.toISOString(),
          roomsToClean: stays.map((stay) => stay.roomNumber).filter(Boolean),
          // Recorded even when zero: "they left owing nothing" is the fact
          // somebody wants back when a bill is disputed a month later.
          outstandingBalance: folio.totals.balance.amount,
        },
      });

      return {
        id: reservation.id,
        status: 'CHECKED_OUT' as const,
        checkedOutAt: now,
        roomsToClean: stays
          .map((stay) => stay.roomNumber)
          .filter((roomNumber): roomNumber is string => roomNumber !== null),
        outstandingBalance: folio.totals.balance.amount,
        currency: folio.currency,
      };
    });
  }
}
