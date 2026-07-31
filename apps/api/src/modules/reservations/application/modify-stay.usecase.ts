import { Inject, Injectable } from '@nestjs/common';
import { businessDate, EVENT_TYPES, errors, money, type IsoDate, type Money } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';
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
  type ModifiableStay,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { PlanStayService } from './plan-stay.service';

export interface ModifyStayInput {
  readonly propertyId: string;
  readonly stayId: string;
  /** Version the caller last read, for optimistic locking. */
  readonly expectedVersion: number;
  readonly roomTypeId?: string;
  readonly ratePlanId?: string;
  readonly checkIn?: IsoDate;
  readonly checkOut?: IsoDate;
  readonly adults?: number;
  readonly children?: number;
  readonly guestName?: string | null;
  readonly reason?: string;
}

export interface ModifyStayResult {
  readonly reservationId: string;
  readonly stayId: string;
  readonly version: number;
  readonly releasedNights: readonly IsoDate[];
  readonly heldNights: readonly IsoDate[];
  readonly roomAssignmentCleared: boolean;
  readonly total: Money;
}

/**
 * Change one stay's dates, room type, rate plan or occupancy.
 *
 * Order matters and is not negotiable: the OLD nights are released BEFORE the
 * new ones are held. A guest moving from the 3rd–5th to the 4th–6th overlaps
 * their own booking on the 4th and 5th; holding first would make them compete
 * with themselves and fail on a sold-out night they already occupy.
 *
 * Everything is one transaction. If pricing or availability refuses, the
 * release is rolled back too — the booking cannot end up holding nothing.
 *
 * DELIBERATE LIMIT: only bookings that have not started can be modified. Once
 * a night is consumed, releasing it would retroactively claim the hotel had a
 * room free on a night a guest slept in it (the same rule cancellation follows,
 * domain-model.md §3.5). Extending a CHECKED_IN stay is a real front-desk
 * operation and needs its own use case that only ever ADDS nights; it is noted
 * in docs/decisions-pending-review.md rather than bolted on here.
 */
@Injectable()
export class ModifyStayUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly planStay: PlanStayService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(
    input: ModifyStayInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<ModifyStayResult> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const stay = await this.reservations.findStay(tx, input.stayId);
      if (!stay || stay.propertyId !== input.propertyId) {
        throw errors.notFound('Stay', input.stayId);
      }

      const reservation = await this.reservations.findById(tx, stay.reservationId);
      if (!reservation) throw errors.notFound('Reservation', stay.reservationId);

      if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
        throw errors.conflict(`A ${reservation.status} booking cannot be modified`, {
          reservationId: reservation.id,
          status: reservation.status,
        });
      }

      const property = await this.propertyRepo.findProperty(tx, stay.propertyId);
      if (!property) throw errors.notFound('Property', stay.propertyId);

      const today = businessDate(property.timezone, now);
      const consumed = stay.nightDates.filter((night) => night < today);
      if (consumed.length > 0) {
        throw errors.conflict('A stay that has already begun cannot be modified', {
          stayId: stay.id,
          consumedNights: consumed,
        });
      }

      const target = this.resolveTarget(stay, input);
      if (this.unchanged(stay, target)) {
        throw errors.validation('Nothing to change');
      }

      /*
       * Release first. See the class comment: the new dates may overlap the
       * old ones, and holding before releasing would have the booking bid
       * against its own nights.
       */
      await this.inventory.lockDates(tx, stay.roomTypeId, [...stay.nightDates]);
      const released = await this.inventory.release(tx, stay.roomTypeId, [...stay.nightDates], 1);
      if (released !== stay.nightDates.length) {
        // `booked` is lower than the reservations referencing it — an integrity
        // bug. Fail loudly rather than paper over a count that cannot be right.
        throw errors.conflict('Inventory release did not match the nights held', {
          stayId: stay.id,
          expected: stay.nightDates.length,
          released,
        });
      }

      // Throws if the new dates are unavailable, restricted or unpriced, which
      // rolls back the release above along with everything else.
      const planned = await this.planStay.plan(tx, property, {
        stayId: stay.id,
        roomTypeId: target.roomTypeId,
        ratePlanId: target.ratePlanId,
        checkIn: target.checkIn,
        checkOut: target.checkOut,
        adults: target.adults,
        children: target.children,
        guestName: target.guestName,
      });

      /*
       * An assigned room survives only an occupancy or name change.
       *
       * Moving dates can collide with another booking in the same room — the
       * exclusion constraint would reject the write with a database error
       * rather than a usable message — and changing room type leaves the guest
       * assigned to a room of the wrong type. Both cases hand the stay back to
       * the front desk to reassign, which is the honest outcome.
       */
      const clearAssignment =
        stay.assignedRoomId !== null &&
        (target.roomTypeId !== stay.roomTypeId ||
          target.checkIn !== stay.checkIn ||
          target.checkOut !== stay.checkOut);

      await this.reservations.replaceStay(tx, stay, planned.record, { clearAssignment });

      // Totals are recomputed from EVERY stay, not by adjusting the old figure:
      // tax and service charge are percentages of the whole booking, so a
      // delta would drift by a rounding unit on each modification.
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

      const heldNights = planned.record.nights.map((night) => night.date);

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: stay.propertyId,
        actor,
        action: 'reservation.modified',
        entityType: 'reservation',
        entityId: stay.reservationId,
        before: {
          stayId: stay.id,
          roomTypeId: stay.roomTypeId,
          ratePlanId: stay.ratePlanId,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          adults: stay.adults,
          children: stay.children,
          subtotal: stay.subtotalMinor,
          total: reservation.totalMinor,
        },
        after: {
          stayId: stay.id,
          roomTypeId: planned.record.roomTypeId,
          ratePlanId: planned.record.ratePlanId,
          checkIn: planned.record.checkIn,
          checkOut: planned.record.checkOut,
          adults: planned.record.adults,
          children: planned.record.children,
          subtotal: planned.record.subtotalMinor,
          total: totals.total.amount,
          roomAssignmentCleared: clearAssignment,
        },
        reason: input.reason ?? null,
      });

      // Both room types are announced: the old one gained a night back and the
      // new one lost one, and a channel told about only half of that would
      // oversell the room type it never heard about.
      const affected = new Map<string, IsoDate[]>();
      affected.set(stay.roomTypeId, [...stay.nightDates]);
      const existing = affected.get(planned.record.roomTypeId) ?? [];
      affected.set(planned.record.roomTypeId, [...existing, ...heldNights]);

      const events: OutboxEventInput[] = [
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
            // Everything a channel must re-read: the nights we gave back and
            // the nights we took.
            affectedDates: [...new Set([...stay.nightDates, ...heldNights])].sort(),
          },
        },
        ...[...affected.entries()].map(([roomTypeId, dates]) => {
          const sorted = [...new Set(dates)].sort();
          return {
            type: EVENT_TYPES.INVENTORY_CHANGED,
            organizationId: tenant.organizationId,
            propertyId: stay.propertyId,
            aggregateType: 'inventory',
            aggregateId: roomTypeId,
            payload: {
              propertyId: stay.propertyId,
              roomTypeId,
              from: sorted[0] as IsoDate,
              to: sorted[sorted.length - 1] as IsoDate,
              reason: 'BOOKED_CHANGED' as const,
            },
          };
        }),
      ];
      await this.outbox.recordMany(tx, events);

      return {
        reservationId: stay.reservationId,
        stayId: stay.id,
        version: input.expectedVersion + 1,
        releasedNights: [...stay.nightDates],
        heldNights,
        roomAssignmentCleared: clearAssignment,
        total: totals.total,
      };
    });
  }

  /** Absent fields keep their current value: this is a PATCH, not a replace. */
  private resolveTarget(stay: ModifiableStay, input: ModifyStayInput) {
    const roomTypeId = input.roomTypeId ?? stay.roomTypeId;
    return {
      roomTypeId,
      /*
       * A new room type without a new rate plan is a contradiction — plans
       * belong to exactly one room type, so keeping the old one would price a
       * suite off the standard-room plan. Refused here with a message that
       * names the fix, rather than as a generic mismatch from the planner.
       */
      ratePlanId:
        input.ratePlanId ??
        (roomTypeId === stay.roomTypeId ? stay.ratePlanId : this.rejectMissingRatePlan(roomTypeId)),
      checkIn: input.checkIn ?? stay.checkIn,
      checkOut: input.checkOut ?? stay.checkOut,
      adults: input.adults ?? stay.adults,
      children: input.children ?? stay.children,
      guestName: input.guestName === undefined ? stay.guestName : input.guestName,
    };
  }

  private rejectMissingRatePlan(roomTypeId: string): never {
    throw errors.validation('Changing the room type requires a rate plan for the new type', {
      roomTypeId,
    });
  }

  private unchanged(
    stay: ModifiableStay,
    target: ReturnType<ModifyStayUseCase['resolveTarget']>,
  ): boolean {
    return (
      target.roomTypeId === stay.roomTypeId &&
      target.ratePlanId === stay.ratePlanId &&
      target.checkIn === stay.checkIn &&
      target.checkOut === stay.checkOut &&
      target.adults === stay.adults &&
      target.children === stay.children &&
      target.guestName === stay.guestName
    );
  }

  /**
   * Re-price the whole booking from its own frozen night prices.
   *
   * Read back AFTER the replace, so the modified stay contributes its new
   * prices and every other stay its untouched ones. Rates are never consulted
   * here: re-quoting the stays nobody changed would move their price whenever
   * someone edited a different room.
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
