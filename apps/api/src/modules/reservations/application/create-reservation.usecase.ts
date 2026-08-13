import { Inject, Injectable } from '@nestjs/common';
import { DomainError, EVENT_TYPES, errors, type IsoDate, type Money } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { newId } from '../../../common/ids';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
  type PropertySettings,
} from '../../properties/domain/property.repository';
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
import {
  PlanStayService,
  type InsufficientInventoryPolicy,
  type OverbookingIncident,
  type PricingSource,
} from './plan-stay.service';

export type { InsufficientInventoryPolicy, OverbookingIncident, PricingSource };

export interface CreateStayInput {
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly children?: number;
  readonly guestName?: string;
  /**
   * The price a CHANNEL sold this stay at. Only the channel delivery path may
   * set it; every public and staff-facing schema is strict, so an amount in a
   * request body is rejected rather than ignored.
   *
   * Without it, an OTA booking is priced from our own rate rows — which stopped
   * being the price the guest paid the moment channel markups existed
   * (docs/channel-markup-plan.md §5).
   */
  readonly channelTotal?: Money;
}

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
  /**
   * CHANNEL when the channel's own price was used. PROPERTY_RATES when a
   * channel total was offered and could not be — the caller has to be able to
   * tell those apart, because the second one is a number to go and check.
   */
  readonly pricedFrom: PricingSource;
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
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly planStay: PlanStayService,
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
      // CHANNEL only if every stay that was offered a channel price took it.
      // One stay quietly falling back to our own rates is the case worth
      // seeing, so it decides the answer for the reservation.
      let pricedFrom: PricingSource = input.stays.some((stay) => stay.channelTotal)
        ? 'CHANNEL'
        : 'PROPERTY_RATES';

      for (const stayInput of input.stays) {
        const stay = await this.planStay.plan(tx, property, stayInput, policy);
        stays.push(stay.record);
        nightPrices.push(...stay.nightPrices);
        overbookings.push(...stay.overbookings);
        if (stayInput.channelTotal && stay.pricedFrom === 'PROPERTY_RATES') {
          pricedFrom = 'PROPERTY_RATES';
        }

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
        pricedFrom,
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
