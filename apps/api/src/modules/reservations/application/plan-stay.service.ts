import { Inject, Injectable } from '@nestjs/common';
import { errors, money, nightsBetween, sum, type IsoDate, type Money } from '@deehub/shared';
import type { Executor } from '../../../database/executor';
import { newId } from '../../../common/ids';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import {
  evaluateExtension,
  evaluateStay,
  isSellable,
  toDomainError,
} from '../../inventory/domain/restrictions';
import type { InventoryDay } from '../../inventory/domain/inventory-day';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
  type PropertySettings,
} from '../../properties/domain/property.repository';
import { RATE_REPOSITORY, type RateRepository } from '../../rates/domain/rate.repository';
import type { StayNightRecord, StayRecord } from '../domain/reservation.repository';

export interface PlanStayInput {
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly children?: number;
  readonly guestName?: string | null;
  /** Reuse an existing stay id when modifying, so the row is replaced in place. */
  readonly stayId?: string;
}

/**
 * What to do when the requested nights are not sellable.
 *
 * REJECT is correct for anything the hotel controls — the guard is the whole
 * point. ACCEPT_AND_ALERT exists only for bookings a channel has ALREADY sold:
 * that guest holds a confirmation, so refusing to record it does not un-sell
 * the room, it just hides the problem (domain-model.md §3.8).
 */
export type InsufficientInventoryPolicy = 'REJECT' | 'ACCEPT_AND_ALERT';

/** Recorded when a channel booking had to be absorbed beyond availability. */
export interface OverbookingIncident {
  readonly roomTypeId: string;
  readonly dates: readonly IsoDate[];
  readonly reason: 'ALLOTMENT_RAISED' | 'RESTRICTION_OVERRIDDEN';
  readonly detail: string;
}

export interface PlannedStay {
  readonly record: StayRecord;
  readonly nightPrices: readonly Money[];
  readonly overbookings: readonly OverbookingIncident[];
}

/** Nights being appended to a stay that is already under way. */
export interface PlanExtensionInput {
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  /** The added nights only — never the ones the stay already holds. */
  readonly nights: readonly IsoDate[];
  /** The new departure date. Not a night, but CTD applies to it. */
  readonly checkOut: IsoDate;
  /** Unchanged by an extension; occupancy pricing still keys on it. */
  readonly adults: number;
}

export interface PlannedExtension {
  readonly nights: readonly StayNightRecord[];
  readonly addedSubtotalMinor: number;
}

/**
 * Turn a request for nights into a held, priced stay.
 *
 * Extracted from the create path because MODIFYING a booking needs exactly the
 * same guarantees: the same locking order, the same restriction evaluation, the
 * same frozen prices. Two copies of this would be two overbooking guards that
 * drift apart, and the one that drifts is the one that oversells.
 *
 * Every method here must be called inside a transaction. It takes inventory.
 */
@Injectable()
export class PlanStayService {
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
  ) {}

  async plan(
    tx: Executor,
    property: PropertySettings,
    input: PlanStayInput,
    policy: InsufficientInventoryPolicy = 'REJECT',
  ): Promise<PlannedStay> {
    const children = input.children ?? 0;

    const roomType = await this.propertyRepo.findRoomType(tx, input.roomTypeId);
    if (!roomType || roomType.propertyId !== property.id) {
      throw errors.notFound('Room type', input.roomTypeId);
    }
    if (!roomType.isActive) {
      throw errors.conflict('Room type is not active', { roomTypeId: roomType.id });
    }

    const ratePlan = await this.propertyRepo.findRatePlan(tx, input.ratePlanId);
    if (!ratePlan || ratePlan.propertyId !== property.id) {
      throw errors.notFound('Rate plan', input.ratePlanId);
    }
    if (!ratePlan.isActive) {
      throw errors.conflict('Rate plan is not active', { ratePlanId: ratePlan.id });
    }
    // A rate plan belongs to exactly one room type; crossing them would sell a
    // suite at a standard-room price.
    if (ratePlan.roomTypeId !== roomType.id) {
      throw errors.validation('Rate plan does not belong to the requested room type', {
        ratePlanId: ratePlan.id,
        roomTypeId: roomType.id,
      });
    }

    this.assertOccupancy(roomType, input.adults, children);

    // nightsBetween throws when checkOut <= checkIn, so date order is enforced
    // by the shared kernel rather than re-checked here.
    const nights = nightsBetween(input.checkIn, input.checkOut);

    const overbookings: OverbookingIncident[] = [];

    // Lock the nights AND the departure date: closed-to-departure is a
    // property of the day the guest leaves, which is not a night we hold.
    const lockedDates: IsoDate[] = [...nights, input.checkOut];
    let locked = await this.inventory.lockDates(tx, roomType.id, lockedDates);
    let byDate = new Map<string, InventoryDay>(locked.map((day) => [day.date, day]));

    const stayRequest = {
      roomTypeId: roomType.id,
      nights,
      checkOut: input.checkOut,
      units: 1,
    };
    const report = evaluateStay(stayRequest, byDate);

    if (!isSellable(report)) {
      if (policy === 'REJECT') {
        throw toDomainError(stayRequest, report);
      }

      // The channel already sold this. Absorb it and make the oversell visible
      // rather than pretending the guest does not exist.
      const short = [...report.soldOutDates, ...report.missingDates];
      if (short.length > 0) {
        const raised = await this.inventory.ensureCapacity(
          tx,
          {
            organizationId: property.organizationId,
            propertyId: property.id,
            roomTypeId: roomType.id,
          },
          short,
          1,
        );
        overbookings.push({
          roomTypeId: roomType.id,
          dates: raised.length > 0 ? raised : short,
          reason: 'ALLOTMENT_RAISED',
          detail: `Allotment raised to absorb a channel booking on ${short.join(', ')}`,
        });
        // Re-read under the same transaction; ensureCapacity changed the rows.
        locked = await this.inventory.lockDates(tx, roomType.id, lockedDates);
        byDate = new Map(locked.map((day) => [day.date, day]));
      }

      if (report.violations.length > 0) {
        overbookings.push({
          roomTypeId: roomType.id,
          dates: report.violations.map((violation) => violation.date),
          reason: 'RESTRICTION_OVERRIDDEN',
          detail: report.violations
            .map((violation) => `${violation.restriction} on ${violation.date}`)
            .join('; '),
        });
      }
    }

    // The rows are locked and capacity is now guaranteed, so this must affect
    // every night. The guard stays as the last line of defence.
    const held = await this.inventory.hold(tx, roomType.id, nights, 1);
    if (held !== nights.length) {
      throw errors.inventoryUnavailable(roomType.id, nights);
    }

    // Occupancy-based pricing keys on the adult count, which is what OTAs send.
    const priced = await this.rates.findPrices(tx, ratePlan.id, nights, input.adults);
    const missing = nights.filter((night) => !priced.has(night));
    if (missing.length > 0) {
      throw errors.rateMissing(ratePlan.id, input.adults, missing);
    }

    const nightPrices: Money[] = [];
    const nightRecords = nights.map((night) => {
      const price = priced.get(night) ?? money(0, property.currency);
      if (price.currency !== property.currency) {
        throw errors.conflict('Rate currency does not match the property currency', {
          ratePlanId: ratePlan.id,
          expected: property.currency,
          actual: price.currency,
        });
      }
      nightPrices.push(price);
      return { date: night, amountMinor: price.amount, currency: price.currency };
    });

    return {
      record: {
        // Modification keeps the id so the row is replaced rather than orphaned
        // alongside a new one, which would double-count the stay.
        id: input.stayId ?? newId(),
        roomTypeId: roomType.id,
        ratePlanId: ratePlan.id,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children,
        guestName: input.guestName ?? null,
        subtotalMinor: sum(nightPrices, property.currency).amount,
        nights: nightRecords,
      },
      nightPrices,
      overbookings,
    };
  }

  /**
   * Hold and price nights APPENDED to an existing stay.
   *
   * The one guarantee that separates this from `plan()`: it never releases
   * anything. The nights the guest has already slept in are not re-evaluated,
   * not re-priced and not handed back — only the new ones are taken.
   *
   * The room type is deliberately not re-checked for `isActive`. Deactivating a
   * room type stops it being SOLD; the guest is already in one, and refusing to
   * extend them because the hotel stopped selling that type tomorrow would be a
   * rule about new business applied to existing business. The rate plan IS
   * checked, because an extension needs a price and an inactive plan has no
   * business quoting one.
   */
  async planExtension(
    tx: Executor,
    property: PropertySettings,
    input: PlanExtensionInput,
  ): Promise<PlannedExtension> {
    if (input.nights.length === 0) {
      throw errors.validation('An extension must add at least one night');
    }

    const ratePlan = await this.propertyRepo.findRatePlan(tx, input.ratePlanId);
    if (!ratePlan || ratePlan.propertyId !== property.id) {
      throw errors.notFound('Rate plan', input.ratePlanId);
    }
    if (!ratePlan.isActive) {
      throw errors.conflict('Rate plan is not active', { ratePlanId: ratePlan.id });
    }
    if (ratePlan.roomTypeId !== input.roomTypeId) {
      throw errors.validation('Rate plan does not belong to the requested room type', {
        ratePlanId: ratePlan.id,
        roomTypeId: input.roomTypeId,
      });
    }

    // Same lock set and same ordering as plan(): added nights plus the new
    // departure date, which carries closed-to-departure.
    const locked = await this.inventory.lockDates(tx, input.roomTypeId, [
      ...input.nights,
      input.checkOut,
    ]);
    const byDate = new Map<string, InventoryDay>(locked.map((day) => [day.date, day]));

    const request = {
      roomTypeId: input.roomTypeId,
      nights: input.nights,
      checkOut: input.checkOut,
      units: 1,
    };
    const report = evaluateExtension(request, byDate);
    if (!isSellable(report)) {
      // REJECT only. ACCEPT_AND_ALERT exists for bookings a channel already
      // sold; nobody has sold these nights yet, so absorbing an oversell here
      // would be inventing one.
      throw toDomainError(request, report);
    }

    const held = await this.inventory.hold(tx, input.roomTypeId, input.nights, 1);
    if (held !== input.nights.length) {
      throw errors.inventoryUnavailable(input.roomTypeId, input.nights);
    }

    const priced = await this.rates.findPrices(tx, ratePlan.id, input.nights, input.adults);
    const missing = input.nights.filter((night) => !priced.has(night));
    if (missing.length > 0) {
      throw errors.rateMissing(ratePlan.id, input.adults, missing);
    }

    const nightPrices: Money[] = [];
    const nights = input.nights.map((night) => {
      const price = priced.get(night) ?? money(0, property.currency);
      if (price.currency !== property.currency) {
        throw errors.conflict('Rate currency does not match the property currency', {
          ratePlanId: ratePlan.id,
          expected: property.currency,
          actual: price.currency,
        });
      }
      nightPrices.push(price);
      return { date: night, amountMinor: price.amount, currency: price.currency };
    });

    return { nights, addedSubtotalMinor: sum(nightPrices, property.currency).amount };
  }

  private assertOccupancy(
    roomType: { id: string; maxOccupancy: number; maxAdults: number; maxChildren: number },
    adults: number,
    children: number,
  ): void {
    if (adults < 1) {
      throw errors.validation('A stay must have at least one adult');
    }
    if (adults > roomType.maxAdults) {
      throw errors.validation(`Room type allows at most ${String(roomType.maxAdults)} adults`, {
        roomTypeId: roomType.id,
        maxAdults: roomType.maxAdults,
        requested: adults,
      });
    }
    if (children > roomType.maxChildren) {
      throw errors.validation(`Room type allows at most ${String(roomType.maxChildren)} children`, {
        roomTypeId: roomType.id,
        maxChildren: roomType.maxChildren,
        requested: children,
      });
    }
    if (adults + children > roomType.maxOccupancy) {
      throw errors.validation(`Room type allows at most ${String(roomType.maxOccupancy)} guests`, {
        roomTypeId: roomType.id,
        maxOccupancy: roomType.maxOccupancy,
        requested: adults + children,
      });
    }
  }
}
