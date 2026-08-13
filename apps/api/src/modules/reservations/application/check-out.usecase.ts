import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { EVENT_TYPES, businessDate, errors, nightsBetween, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { physicalRooms, reservationStayNights, reservationStays } from '../../../database/schema';
import { GetFolioQuery } from '../../folio/application/get-folio.query';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { assertTransition, type ReservationStatus } from '../domain/reservation-status';

export interface CheckOutInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
  /**
   * Hand tonight — and any later night this booking still holds — back to sale.
   *
   * Off by default, because it is only right when the guest has actually gone.
   * See the class comment for why it is a flag on check-out rather than an
   * operation of its own.
   */
  readonly releaseRemainingNights?: boolean;
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
  /** Nights handed back to sale. Zero unless the caller asked. */
  readonly nightsReleased: readonly IsoDate[];
}

/**
 * Check a booking out.
 *
 * By default it does not release inventory: a guest who stayed to the end of
 * their booking consumed those nights, and giving them back would make
 * historical occupancy lie.
 *
 * `releaseRemainingNights` is for the other case, and it is the reason this
 * file changed. A guest checks in at noon and leaves at six. The night they
 * booked is paid for and is NOT slept in; the room stands empty and, until
 * now, unsellable until the next morning — which is the single complaint the
 * first pilot property had about every system it has used
 * (`docs/early-checkout-plan.md`).
 *
 * What it does and does not touch is the whole design:
 *
 *   - the booking KEEPS its dates, so the guest stays charged in full — room
 *     charges derive from the frozen nights, and nothing here alters them;
 *   - the nights from today onward go back to the allotment, so the room can
 *     be sold again tonight;
 *   - `nights_released_early` records how many, so a report can subtract them
 *     and a night sold twice does not read as two rooms out of one.
 *
 * It is a flag on check-out rather than a second endpoint on purpose. Leaving
 * the room on sale is one thought at the desk — "they've gone, put it back" —
 * and a separate call is a step a busy person forgets, which leaves exactly the
 * locked room this exists to unlock.
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
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    private readonly folio: GetFolioQuery,
    private readonly outbox: OutboxService,
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
        id: reservationStays.id,
        roomTypeId: reservationStays.roomTypeId,
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
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

    const property = input.releaseRemainingNights
      ? await this.properties.findProperty(this.db, input.propertyId)
      : null;
    if (input.releaseRemainingNights && !property) {
      throw errors.notFound('Property', input.propertyId);
    }
    const today = property ? businessDate(property.timezone, now) : null;

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

      const nightsReleased = today
        ? await this.releaseUnusedNights(tx, stays, today, tenant.organizationId, input.propertyId)
        : [];

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
          // Which nights went back on sale, and therefore which nights the
          // guest paid for without occupying. The question "why was room 3
          // sold twice on the 13th" has to be answerable from here.
          nightsReleased,
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
        nightsReleased,
      };
    });
  }

  /**
   * Give back the nights this booking still holds from today onward.
   *
   * Today's night counts as unused: the night of the 13th is the night BETWEEN
   * the 13th and the 14th, so a guest walking out on the 13th has not slept it.
   * Nights before today are never touched — those were slept in, and handing
   * them back would let the room be sold for a date that has already happened.
   *
   * The stay's dates are deliberately left alone. Shortening them here would
   * take the money off the bill with them, which is `shorten-stay`'s job and
   * the opposite of what this is for.
   */
  private async releaseUnusedNights(
    tx: Executor,
    stays: readonly { id: string; roomTypeId: string; checkIn: string; checkOut: string }[],
    today: IsoDate,
    organizationId: string,
    propertyId: string,
  ): Promise<readonly IsoDate[]> {
    const releasedAll: IsoDate[] = [];

    for (const stay of stays) {
      const checkOut = stay.checkOut as IsoDate;
      const from = (stay.checkIn > today ? stay.checkIn : today) as IsoDate;
      if (from >= checkOut) continue; // nothing left that has not been slept

      const nights = nightsBetween(from, checkOut);
      if (nights.length === 0) continue;

      // Same lock order as the booking path, so a check-out and a booking
      // racing for the same nights queue instead of deadlocking.
      await this.inventory.lockDates(tx, stay.roomTypeId, nights);
      const released = await this.inventory.release(tx, stay.roomTypeId, nights, 1);
      if (released !== nights.length) {
        // `booked` is lower than the reservations referencing it — an
        // integrity bug. Fail the transaction rather than paper over it.
        throw errors.conflict('Inventory release did not match the nights held', {
          stayId: stay.id,
          expected: nights.length,
          released,
        });
      }

      // Flagged per night, because the performance report groups by date and a
      // count cannot tell it WHICH dates stopped being occupied. The rows stay:
      // the money is real and the folio derives from them.
      await tx
        .update(reservationStayNights)
        .set({ releasedEarly: true })
        .where(
          and(
            eq(reservationStayNights.organizationId, organizationId),
            eq(reservationStayNights.stayId, stay.id),
            gte(reservationStayNights.date, from),
          ),
        );

      // The same fact at stay level, for a screen that wants one number.
      await tx
        .update(reservationStays)
        .set({
          nightsReleasedEarly: sql`${reservationStays.nightsReleasedEarly} + ${nights.length}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reservationStays.organizationId, organizationId),
            eq(reservationStays.id, stay.id),
          ),
        );

      // The room is back on sale, so every channel needs to hear about it —
      // this is the whole point of releasing rather than waiting for morning.
      await this.outbox.recordMany(tx, [
        {
          type: EVENT_TYPES.INVENTORY_CHANGED,
          organizationId,
          propertyId,
          aggregateType: 'inventory',
          aggregateId: stay.roomTypeId,
          payload: {
            propertyId,
            roomTypeId: stay.roomTypeId,
            from: nights[0] as IsoDate,
            to: nights[nights.length - 1] as IsoDate,
            reason: 'BOOKED_CHANGED' as const,
          },
        },
      ]);

      releasedAll.push(...nights);
    }

    return releasedAll;
  }
}
