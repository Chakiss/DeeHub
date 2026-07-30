import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  EVENT_TYPES,
  errors,
  money,
  nightsBetween,
  sum,
  type IsoDate,
  type Money,
} from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { newId } from '../../../common/ids';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepository,
} from '../../inventory/domain/inventory.repository';
import { evaluateStay, isSellable, toDomainError } from '../../inventory/domain/restrictions';
import type { InventoryDay } from '../../inventory/domain/inventory-day';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
  type PropertySettings,
} from '../../properties/domain/property.repository';
import { RATE_REPOSITORY, type RateRepository } from '../../rates/domain/rate.repository';
import { computeBreakdown } from '../domain/pricing';
import { generateReservationCode } from '../domain/reservation-code';
import { LinkGuestUseCase } from '../../guests/application/link-guest.usecase';
import type { ReservationStatus } from '../domain/reservation-status';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
  type ReservationSource,
  type StayRecord,
} from '../domain/reservation.repository';

export interface CreateStayInput {
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly children?: number;
  readonly guestName?: string;
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

export interface CreateReservationInput {
  readonly propertyId: string;
  readonly source: ReservationSource;
  /** CONFIRMED by default; PENDING creates an expiring hold. */
  readonly status?: Extract<ReservationStatus, 'PENDING' | 'CONFIRMED'>;
  readonly booker: { readonly name: string; readonly email?: string; readonly phone?: string };
  readonly stays: readonly CreateStayInput[];
  readonly specialRequests?: string;
  readonly channelId?: string;
  readonly guestId?: string;
  /** Hold lifetime for PENDING reservations. Defaults to 15 minutes. */
  readonly holdTtlSeconds?: number;
  /** Defaults to REJECT. Only the channel delivery path may relax this. */
  readonly onInsufficientInventory?: InsufficientInventoryPolicy;
}

/** Recorded when a channel booking had to be absorbed beyond availability. */
export interface OverbookingIncident {
  readonly roomTypeId: string;
  readonly dates: readonly IsoDate[];
  readonly reason: 'ALLOTMENT_RAISED' | 'RESTRICTION_OVERRIDDEN';
  readonly detail: string;
}

export interface CreateReservationResult {
  readonly id: string;
  readonly code: string;
  readonly status: ReservationStatus;
  readonly currency: string;
  readonly subtotal: Money;
  readonly serviceCharge: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly stays: readonly StayRecord[];
  /** Non-empty only when a channel booking was absorbed beyond availability. */
  readonly overbookings: readonly OverbookingIncident[];
}

const DEFAULT_HOLD_TTL_SECONDS = 900;
const CODE_COLLISION_RETRIES = 3;
const UNIQUE_VIOLATION = '23505';

/**
 * Create a reservation.
 *
 * The single most important write path in the product. Everything happens in
 * ONE transaction (architecture.md §4): inventory is held with the guarded
 * update, prices are snapshotted, the aggregate is written, the change is
 * audited, and the events that will reach the OTAs go to the outbox. If any
 * step fails, no room is silently consumed and no channel is told about a
 * booking that does not exist.
 */
@Injectable()
export class CreateReservationUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly guests: LinkGuestUseCase,
  ) {}

  async execute(
    input: CreateReservationInput,
    actor: AuditActor,
  ): Promise<CreateReservationResult> {
    if (input.stays.length === 0) {
      throw errors.validation('A reservation must contain at least one stay');
    }

    // A generated code can collide with an existing one. The unique index is
    // the authority, so we retry the whole transaction rather than trusting a
    // pre-check that would race anyway.
    let lastError: unknown;
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      try {
        return await this.attempt(input, actor);
      } catch (error) {
        if (!this.isCodeCollision(error)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new DomainError('INTERNAL_ERROR', 'Could not allocate a reservation code');
  }

  private async attempt(
    input: CreateReservationInput,
    actor: AuditActor,
  ): Promise<CreateReservationResult> {
    const tenant = requireTenant();
    const status: ReservationStatus = input.status ?? 'CONFIRMED';

    return this.db.transaction(async (tx) => {
      const property = await this.loadProperty(tx, input.propertyId);
      const reservationId = newId();

      /*
       * Attach a guest profile inside this transaction.
       *
       * An explicit guestId wins — a channel or a later booking flow may
       * already know who this is. Otherwise the booker becomes the guest,
       * matched conservatively: this is what makes stay history accrue at all,
       * and until now every reservation was written with guestId null.
       */
      const guestId =
        input.guestId ??
        (await this.guests.execute(tx, {
          organizationId: tenant.organizationId,
          name: input.booker.name,
          email: input.booker.email ?? null,
          phone: input.booker.phone ?? null,
        }));
      const stays: StayRecord[] = [];
      const nightPrices: Money[] = [];
      const overbookings: OverbookingIncident[] = [];
      const touchedRoomTypes = new Map<string, { from: IsoDate; to: IsoDate }>();
      const policy = input.onInsufficientInventory ?? 'REJECT';

      for (const stayInput of input.stays) {
        const stay = await this.prepareStay(tx, property, stayInput, policy);
        stays.push(stay.record);
        nightPrices.push(...stay.nightPrices);
        overbookings.push(...stay.overbookings);

        const existing = touchedRoomTypes.get(stay.record.roomTypeId);
        touchedRoomTypes.set(stay.record.roomTypeId, {
          from:
            existing && existing.from < stay.record.checkIn ? existing.from : stay.record.checkIn,
          to: existing && existing.to > stay.record.checkOut ? existing.to : stay.record.checkOut,
        });
      }

      const breakdown = computeBreakdown(nightPrices, property.currency, {
        taxRateBp: property.taxRateBp,
        serviceChargeRateBp: property.serviceChargeRateBp,
        pricesIncludeTax: property.pricesIncludeTax,
      });

      const code = generateReservationCode();
      const holdExpiresAt =
        status === 'PENDING'
          ? new Date(Date.now() + (input.holdTtlSeconds ?? DEFAULT_HOLD_TTL_SECONDS) * 1000)
          : null;

      await this.reservations.insert(tx, {
        id: reservationId,
        organizationId: tenant.organizationId,
        propertyId: property.id,
        code,
        status,
        source: input.source,
        channelId: input.channelId ?? null,
        guestId,
        bookerName: input.booker.name,
        bookerEmail: input.booker.email ?? null,
        bookerPhone: input.booker.phone ?? null,
        currency: property.currency,
        subtotalMinor: breakdown.subtotal.amount,
        serviceChargeMinor: breakdown.serviceCharge.amount,
        taxMinor: breakdown.tax.amount,
        totalMinor: breakdown.total.amount,
        holdExpiresAt,
        specialRequests: input.specialRequests ?? null,
        stays,
      });

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: property.id,
        actor,
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservationId,
        after: {
          code,
          status,
          source: input.source,
          total: breakdown.total.amount,
          currency: property.currency,
          stays: stays.map((stay) => ({
            roomTypeId: stay.roomTypeId,
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
          })),
        },
      });

      // Events go to the outbox inside this transaction. The relay picks them
      // up after commit, so OTAs learn about the booking if and only if it
      // actually exists.
      const events: OutboxEventInput[] = [
        {
          type: EVENT_TYPES.RESERVATION_CREATED,
          organizationId: tenant.organizationId,
          propertyId: property.id,
          aggregateType: 'reservation',
          aggregateId: reservationId,
          payload: {
            reservationId,
            propertyId: property.id,
            code,
            status,
            channelId: input.channelId ?? null,
            affectedDates: stays.flatMap((stay) => stay.nights.map((night) => night.date)),
          },
        },
        ...[...touchedRoomTypes.entries()].map(([roomTypeId, range]) => ({
          type: EVENT_TYPES.INVENTORY_CHANGED,
          organizationId: tenant.organizationId,
          propertyId: property.id,
          aggregateType: 'inventory',
          aggregateId: roomTypeId,
          payload: {
            propertyId: property.id,
            roomTypeId,
            from: range.from,
            to: range.to,
            reason: 'BOOKED_CHANGED' as const,
          },
        })),
      ];

      if (overbookings.length > 0) {
        // Urgent by design: an oversell needs a human to move a guest or find a
        // room today. Silently absorbing it would be the worse failure.
        events.push({
          type: EVENT_TYPES.CHANNEL_OVERBOOKING_DETECTED,
          organizationId: tenant.organizationId,
          propertyId: property.id,
          aggregateType: 'reservation',
          aggregateId: reservationId,
          payload: {
            reservationId,
            propertyId: property.id,
            code,
            channelId: input.channelId ?? null,
            incidents: overbookings.map((incident) => ({
              ...incident,
              dates: [...incident.dates],
            })),
          },
        });
      }

      await this.outbox.recordMany(tx, events);

      return {
        id: reservationId,
        code,
        status,
        currency: property.currency,
        subtotal: breakdown.subtotal,
        serviceCharge: breakdown.serviceCharge,
        tax: breakdown.tax,
        total: breakdown.total,
        stays,
        overbookings,
      };
    });
  }

  private async loadProperty(tx: Executor, propertyId: string): Promise<PropertySettings> {
    const property = await this.propertyRepo.findProperty(tx, propertyId);
    // A property in another tenant is indistinguishable from one that does not
    // exist — a 403 here would confirm its existence (api-spec.md §4).
    if (!property) throw errors.notFound('Property', propertyId);
    if (property.status !== 'ACTIVE') {
      throw errors.conflict('Property is not active', { propertyId });
    }
    return property;
  }

  private async prepareStay(
    tx: Executor,
    property: PropertySettings,
    input: CreateStayInput,
    policy: InsufficientInventoryPolicy,
  ): Promise<{ record: StayRecord; nightPrices: Money[]; overbookings: OverbookingIncident[] }> {
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
        id: newId(),
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

  /**
   * Drizzle re-throws driver errors wrapped in its own Error with the pg error
   * on `cause`, so the check has to unwrap. Testing only the top level would
   * silently never match, and a code collision would surface as a 500 instead
   * of being retried.
   */
  private isCodeCollision(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
      if (typeof candidate.code === 'string') {
        return (
          candidate.code === UNIQUE_VIOLATION &&
          typeof candidate.constraint === 'string' &&
          candidate.constraint.includes('reservations_property_code_uq')
        );
      }
      current = candidate.cause;
    }
    return false;
  }
}
