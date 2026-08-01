import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_TYPES,
  businessDate,
  errors,
  money,
  nightsBetween,
  type IsoDate,
  type Money,
} from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { reservationStayNights } from '../../../database/schema';
import { and, eq, gte, sql } from 'drizzle-orm';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { computeBreakdown } from '../domain/pricing';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';

export interface ShortenStayInput {
  readonly propertyId: string;
  readonly stayId: string;
  /** Version the caller last read, for optimistic locking. */
  readonly expectedVersion: number;
  /** The new departure date. Must be earlier than the current one. */
  readonly checkOut: IsoDate;
  readonly reason?: string;
}

export interface ShortenStayResult {
  readonly reservationId: string;
  readonly stayId: string;
  readonly version: number;
  readonly checkOut: IsoDate;
  readonly releasedNights: readonly IsoDate[];
  /** What came off the bill. Positive: the amount no longer charged. */
  readonly refundedAmount: Money;
  readonly total: Money;
}

/** The same set `ExtendStayUseCase` allows: a stay with a future left to cut. */
const SHORTENABLE = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN']);

/**
 * A guest leaves early: drop nights from the END of a stay.
 *
 * The mirror of `ExtendStayUseCase`, and its own use case for the same reason
 * that one is. Modifying a stay releases every night and takes new ones, which
 * is why it refuses a stay that has begun — giving back a night a guest slept in
 * would retroactively claim the room was free. This only ever releases nights
 * from the tail, and only ones that have not started, so a guest standing at the
 * desk this morning can check out four days early.
 *
 * **It does not charge a penalty, and will not decide one for you.** Most hotels
 * have an early-departure policy — one night, or the whole balance on a
 * non-refundable rate — and this removes the charge for every dropped night with
 * nothing added back.
 *
 * What is missing is not somewhere to put a fee: the guest's folio exists, and
 * the desk can post one against it in the same breath as this. What is missing
 * is the POLICY. Nothing on a rate plan says what leaving early costs, so any
 * number invented here would be a guess applied silently to every booking —
 * including the flexible ones a hotel deliberately sells as free to cancel.
 * A rule the hotel wrote is worth building; a rule this code made up is not.
 *
 * The room assignment is kept. The range only narrows, so unlike an extension
 * there is nothing the room-overlap constraint can refuse — and the guest is in
 * that room until they leave.
 */
@Injectable()
export class ShortenStayUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(
    input: ShortenStayInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<ShortenStayResult> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const stay = await this.reservations.findStay(tx, input.stayId);
      if (!stay || stay.propertyId !== input.propertyId) {
        throw errors.notFound('Stay', input.stayId);
      }

      const reservation = await this.reservations.findById(tx, stay.reservationId);
      if (!reservation) throw errors.notFound('Reservation', stay.reservationId);

      if (!SHORTENABLE.has(reservation.status)) {
        throw errors.conflict(`A ${reservation.status} booking cannot be shortened`, {
          reservationId: reservation.id,
          status: reservation.status,
        });
      }

      if (input.checkOut >= stay.checkOut) {
        throw errors.validation('An early departure must move check-out earlier', {
          stayId: stay.id,
          checkOut: stay.checkOut,
          requested: input.checkOut,
        });
      }

      /*
       * A stay has to keep at least one night. Cutting it to nothing is a
       * cancellation — which releases the room, tells the guest, and moves the
       * booking to CANCELLED — and quietly producing a zero-night reservation
       * here would leave a booking that occupies no inventory, appears on no
       * night, and nobody ever closes.
       */
      if (input.checkOut <= stay.checkIn) {
        throw errors.validation(
          'A stay must keep at least one night. Cancel the booking instead of shortening it to nothing.',
          { stayId: stay.id, checkIn: stay.checkIn, requested: input.checkOut },
        );
      }

      const property = await this.propertyRepo.findProperty(tx, stay.propertyId);
      if (!property) throw errors.notFound('Property', stay.propertyId);

      const today = businessDate(property.timezone, now);

      /*
       * The night of the 3rd is the night BETWEEN the 3rd and the 4th, so a
       * guest leaving on the 3rd has not consumed it and it is releasable. The
       * 2nd is: they slept through it. Refusing rather than silently keeping
       * the consumed nights, because "check them out as of yesterday" is a
       * request with a real intent behind it — usually a correction — and
       * guessing at it would produce a booking whose dates disagree with what
       * happened in the building.
       */
      if (input.checkOut < today) {
        throw errors.validation(
          'That date is in the past. Nights the guest has already slept cannot be released.',
          { stayId: stay.id, today, requested: input.checkOut },
        );
      }

      const releasedNights = nightsBetween(input.checkOut, stay.checkOut);

      // Same order the booking path locks in, so a shortening and a booking
      // racing for the same nights queue rather than deadlock.
      await this.inventory.lockDates(tx, stay.roomTypeId, releasedNights);
      const released = await this.inventory.release(tx, stay.roomTypeId, releasedNights, 1);
      if (released !== releasedNights.length) {
        // `booked` is lower than the reservations referencing it — an integrity
        // bug. Fail the transaction rather than paper over it.
        throw errors.conflict('Inventory release did not match the nights held', {
          reservationId: reservation.id,
          stayId: stay.id,
          expected: releasedNights.length,
          released,
        });
      }

      const droppedMinor = await this.sumNightAmounts(tx, stay.id, input.checkOut);

      const removed = await this.reservations.shortenStay(tx, stay, {
        checkOut: input.checkOut,
        subtotalMinor: stay.subtotalMinor - droppedMinor,
      });
      if (removed !== releasedNights.length) {
        throw errors.conflict('The nights removed did not match the nights released', {
          stayId: stay.id,
          expected: releasedNights.length,
          removed,
        });
      }

      // Recomputed from every surviving frozen night, never by subtracting a
      // delta: tax and service charge are percentages of the whole, so a delta
      // drifts by a rounding unit each time.
      const totals = await this.recomputeTotals(tx, stay.reservationId, property);

      const bumped = await this.reservations.updateTotals(
        tx,
        stay.reservationId,
        input.expectedVersion,
        {
          subtotalMinor: totals.subtotal.amount,
          taxMinor: totals.tax.amount,
          serviceChargeMinor: totals.serviceCharge.amount,
          totalMinor: totals.total.amount,
        },
      );
      if (bumped !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: stay.propertyId,
        actor,
        action: 'reservation.shortened',
        entityType: 'reservation',
        entityId: stay.reservationId,
        before: {
          stayId: stay.id,
          checkOut: stay.checkOut,
          subtotal: stay.subtotalMinor,
          total: reservation.totalMinor,
        },
        after: {
          stayId: stay.id,
          checkOut: input.checkOut,
          releasedNights,
          subtotal: stay.subtotalMinor - droppedMinor,
          total: totals.total.amount,
          // Kept: the guest is in that room until they walk out of it.
          assignedRoomId: stay.assignedRoomId,
          // Nothing was charged for leaving early. Recorded explicitly so a
          // fee posted to the folio afterwards is visibly a separate, human
          // decision rather than something this operation might have done.
          earlyDepartureFeeMinor: 0,
        },
        reason: input.reason ?? null,
      });

      await this.outbox.recordMany(tx, [
        {
          type: EVENT_TYPES.RESERVATION_MODIFIED,
          organizationId: tenant.organizationId,
          propertyId: stay.propertyId,
          aggregateType: 'reservation',
          aggregateId: stay.reservationId,
          payload: {
            reservationId: stay.reservationId,
            propertyId: stay.propertyId,
            code: reservation.code,
            status: reservation.status,
            channelId: null,
            // Only the released nights changed; the nights still held are
            // untouched and re-pushing them would be noise.
            affectedDates: [...releasedNights],
          },
        },
        {
          type: EVENT_TYPES.INVENTORY_CHANGED,
          organizationId: tenant.organizationId,
          propertyId: stay.propertyId,
          aggregateType: 'inventory',
          aggregateId: stay.roomTypeId,
          payload: {
            propertyId: stay.propertyId,
            roomTypeId: stay.roomTypeId,
            from: releasedNights[0] as IsoDate,
            to: releasedNights[releasedNights.length - 1] as IsoDate,
            reason: 'BOOKED_CHANGED' as const,
          },
        },
      ]);

      return {
        reservationId: stay.reservationId,
        stayId: stay.id,
        version: input.expectedVersion + 1,
        checkOut: input.checkOut,
        releasedNights,
        refundedAmount: money(droppedMinor, property.currency),
        total: totals.total,
      };
    });
  }

  /**
   * What the dropped nights were priced at — read from the frozen amounts, not
   * re-quoted, so a rate that moved since booking does not change the credit.
   */
  private async sumNightAmounts(tx: Executor, stayId: string, from: IsoDate): Promise<number> {
    const rows = await tx
      .select({ total: sql<string>`coalesce(sum(${reservationStayNights.amountMinor}), 0)` })
      .from(reservationStayNights)
      .where(and(eq(reservationStayNights.stayId, stayId), gte(reservationStayNights.date, from)));
    return Number(rows[0]?.total ?? 0);
  }

  /** Re-price the whole booking from its own surviving frozen night prices. */
  private async recomputeTotals(
    tx: Executor,
    reservationId: string,
    property: {
      currency: string;
      taxRateBp: number;
      serviceChargeRateBp: number;
      pricesIncludeTax: boolean;
    },
  ) {
    const amounts = await this.reservations.findNightAmounts(tx, reservationId);
    const nightPrices: Money[] = amounts.map((amount) => money(amount, property.currency));

    return computeBreakdown(nightPrices, property.currency, {
      taxRateBp: property.taxRateBp,
      serviceChargeRateBp: property.serviceChargeRateBp,
      pricesIncludeTax: property.pricesIncludeTax,
    });
  }
}
