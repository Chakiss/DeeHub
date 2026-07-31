import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_TYPES,
  errors,
  money,
  nightsBetween,
  type IsoDate,
  type Money,
} from '@deehub/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { isExclusionViolation, ROOM_OVERLAP_CONSTRAINT } from '../../../database/postgres-errors';
import { physicalRooms, reservationStays, reservations } from '../../../database/schema';
import { requireOrganizationId, requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { computeBreakdown } from '../domain/pricing';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { PlanStayService } from './plan-stay.service';

export interface ExtendStayInput {
  readonly propertyId: string;
  readonly stayId: string;
  /** Version the caller last read, for optimistic locking. */
  readonly expectedVersion: number;
  /** The new departure date. Must be later than the current one. */
  readonly checkOut: IsoDate;
  readonly reason?: string;
}

export interface ExtendStayResult {
  readonly reservationId: string;
  readonly stayId: string;
  readonly version: number;
  readonly checkOut: IsoDate;
  readonly addedNights: readonly IsoDate[];
  readonly addedAmount: Money;
  readonly total: Money;
}

/** Bookings that still have a future to extend into. */
const EXTENDABLE = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN']);

/**
 * Keep a guest longer: add nights to the END of a stay.
 *
 * This exists as its own use case rather than a flag on `ModifyStayUseCase`
 * because the two have opposite relationships with inventory. Modifying
 * RELEASES the stay's nights and takes new ones, which is why it refuses a stay
 * that has begun — giving back a night a guest slept in would retroactively
 * claim the room was free. Extending only ever TAKES. Nothing is released,
 * nothing already consumed is touched, so a guest who is in the building right
 * now can be extended, which is the whole point.
 *
 * Everything is one transaction. If the new nights cannot be held, priced, or
 * kept in the same room, the booking is left exactly as it was.
 */
@Injectable()
export class ExtendStayUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly planStay: PlanStayService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ExtendStayInput, actor: AuditActor): Promise<ExtendStayResult> {
    const tenant = requireTenant();

    try {
      return await this.db.transaction(async (tx) => {
        const stay = await this.reservations.findStay(tx, input.stayId);
        if (!stay || stay.propertyId !== input.propertyId) {
          throw errors.notFound('Stay', input.stayId);
        }

        const reservation = await this.reservations.findById(tx, stay.reservationId);
        if (!reservation) throw errors.notFound('Reservation', stay.reservationId);

        if (!EXTENDABLE.has(reservation.status)) {
          throw errors.conflict(`A ${reservation.status} booking cannot be extended`, {
            reservationId: reservation.id,
            status: reservation.status,
          });
        }

        if (input.checkOut <= stay.checkOut) {
          // Shortening is early departure: it would have to decide what happens
          // to a night already paid for and to the housekeeping schedule. A
          // different decision, and not this one silently.
          throw errors.validation('An extension must move check-out later', {
            stayId: stay.id,
            checkOut: stay.checkOut,
            requested: input.checkOut,
          });
        }

        const property = await this.propertyRepo.findProperty(tx, stay.propertyId);
        if (!property) throw errors.notFound('Property', stay.propertyId);

        // The added nights are [old check-out, new check-out): the old check-out
        // day was never a night this stay held, and it becomes one.
        const addedNights = nightsBetween(stay.checkOut, input.checkOut);

        const planned = await this.planStay.planExtension(tx, property, {
          roomTypeId: stay.roomTypeId,
          ratePlanId: stay.ratePlanId,
          nights: addedNights,
          checkOut: input.checkOut,
          adults: stay.adults,
        });

        await this.reservations.extendStay(tx, stay, {
          checkOut: input.checkOut,
          nights: planned.nights,
          subtotalMinor: stay.subtotalMinor + planned.addedSubtotalMinor,
        });

        // Recomputed from every frozen night on the booking, never by adding a
        // delta: tax and service charge are percentages of the whole, so a
        // delta would drift by a rounding unit on each extension.
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
          action: 'reservation.extended',
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
            addedNights,
            subtotal: stay.subtotalMinor + planned.addedSubtotalMinor,
            total: totals.total.amount,
            // Kept, not cleared: staying in the same room is the point of
            // extending rather than rebooking.
            assignedRoomId: stay.assignedRoomId,
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
              // Only the added nights changed. The nights already held are
              // untouched, so re-pushing them would be noise a channel has to
              // reconcile against numbers that did not move.
              affectedDates: [...addedNights],
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
              from: addedNights[0] as IsoDate,
              to: addedNights[addedNights.length - 1] as IsoDate,
              reason: 'BOOKED_CHANGED' as const,
            },
          },
        ]);

        return {
          reservationId: stay.reservationId,
          stayId: stay.id,
          version: input.expectedVersion + 1,
          checkOut: input.checkOut,
          addedNights,
          addedAmount: money(planned.addedSubtotalMinor, property.currency),
          total: totals.total,
        };
      });
    } catch (error) {
      /*
       * The room is held by the database, not by a check in this method: two
       * clerks extending different guests into the same room cannot be made
       * atomic without locking the room. Postgres refuses one of them; turn
       * that into something the front desk can act on.
       *
       * Refusing is correct here, unlike in a modification, which clears the
       * assignment instead. A guest who is physically in room 302 tonight
       * cannot be quietly un-assigned — someone has to be moved, and that is a
       * decision for the desk.
       */
      if (isExclusionViolation(error, ROOM_OVERLAP_CONSTRAINT)) {
        throw await this.describeRoomConflict(input);
      }
      throw error;
    }
  }

  /** Name the room and the booking in the way, so the desk can move someone. */
  private async describeRoomConflict(input: ExtendStayInput): Promise<Error> {
    const organizationId = requireOrganizationId();

    const rows = await this.db
      .select({
        roomNumber: physicalRooms.roomNumber,
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
        code: reservations.code,
      })
      .from(reservationStays)
      .innerJoin(reservations, eq(reservations.id, reservationStays.reservationId))
      .innerJoin(physicalRooms, eq(physicalRooms.id, reservationStays.assignedRoomId))
      .where(
        and(
          eq(reservationStays.organizationId, organizationId),
          eq(reservationStays.propertyId, input.propertyId),
          ne(reservationStays.id, input.stayId),
          sql`${reservationStays.assignedRoomId} = (
            SELECT assigned_room_id FROM reservation_stays WHERE id = ${input.stayId}
          )`,
          sql`daterange(${reservationStays.checkIn}, ${reservationStays.checkOut}, '[)')
            && daterange((SELECT check_in FROM reservation_stays WHERE id = ${input.stayId}),
                         ${input.checkOut}, '[)')`,
        ),
      )
      .limit(1);

    const conflict = rows[0];
    if (!conflict) {
      return errors.conflict('The assigned room is taken for part of the extension', {
        stayId: input.stayId,
      });
    }

    return errors.conflict(
      `Room ${conflict.roomNumber} is taken by ${conflict.code} from ${conflict.checkIn} to ${conflict.checkOut}. Move one of the guests before extending.`,
      {
        stayId: input.stayId,
        roomNumber: conflict.roomNumber,
        conflictingReservation: conflict.code,
        from: conflict.checkIn,
        to: conflict.checkOut,
      },
    );
  }

  /**
   * Re-price the whole booking from its own frozen night prices.
   *
   * The rate plan is not consulted for nights that already existed: re-quoting
   * them would move a price the guest was given, and for a night already slept
   * in it would rewrite history.
   */
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
