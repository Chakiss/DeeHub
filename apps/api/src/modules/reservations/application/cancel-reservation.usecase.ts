import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { businessDate, errors, EVENT_TYPES, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { reservationStays } from '../../../database/schema';
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
import { RecordPaymentUseCase } from '../../folio/application/record-payment.usecase';
import type { FolioPaymentMethod } from '../../folio/domain/folio';
import { assertTransition } from '../domain/reservation-status';
import { QuoteCancellationUseCase } from './quote-cancellation.usecase';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';

export interface CancelReservationInput {
  readonly reservationId: string;
  /** Version the caller last read, for optimistic locking. */
  readonly expectedVersion: number;
  readonly reason?: string;
  /**
   * The refund the desk chose. Absent means "not decided here": no folio row and
   * no refund audit. The figure the desk SAW is never sent; the server requotes.
   */
  readonly refund?: {
    readonly amountMinor: number;
    readonly method: FolioPaymentMethod;
    readonly note?: string;
  };
}

export interface CancelReservationResult {
  readonly id: string;
  readonly status: 'CANCELLED';
  /** Nights whose inventory was returned to the pool. */
  readonly releasedNights: readonly IsoDate[];
  /** Nights already consumed, which stay counted in occupancy history. */
  readonly retainedNights: readonly IsoDate[];
  /** The folio REFUND recorded with the cancellation, when one was. */
  readonly refund: {
    readonly amountMinor: number;
    readonly method: FolioPaymentMethod;
    readonly paymentId: string;
  } | null;
}

/**
 * Cancel a reservation and return unconsumed inventory.
 *
 * The subtle rule (domain-model.md §3.5): only nights on or after the
 * property's current BUSINESS DATE are released. Nights the guest already
 * occupied stay counted, otherwise cancelling a stay in progress would
 * retroactively claim the hotel had rooms free on nights it did not.
 */
@Injectable()
export class CancelReservationUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly quoteCancellation: QuoteCancellationUseCase,
    private readonly recordPayment: RecordPaymentUseCase,
  ) {}

  async execute(
    input: CancelReservationInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<CancelReservationResult> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const reservation = await this.reservations.findById(tx, input.reservationId);
      if (!reservation) throw errors.notFound('Reservation', input.reservationId);

      // Domain owns the state machine: cancelling a checked-out or already
      // cancelled reservation is rejected here, not in the UI.
      assertTransition(reservation.status, 'CANCELLED');

      const property = await this.propertyRepo.findProperty(tx, reservation.propertyId);
      if (!property) throw errors.notFound('Property', reservation.propertyId);

      /*
       * Refund, decided BEFORE anything is released and inside this same
       * transaction: the quote is recomputed here from the frozen policy and the
       * folio as it stands now, so a stale screen cannot post a refund the rules
       * would not give, and an over-refund (rejected by RecordPayment's own
       * rule) rolls the whole cancellation back.
       */
      let refundResult: CancelReservationResult['refund'] = null;
      let refundAudit: Record<string, unknown> | null = null;
      if (input.refund) {
        const quote = await this.quoteCancellation.quoteIn(
          tx,
          reservation.propertyId,
          reservation.id,
          now,
        );
        const note = input.refund.note?.trim() ?? '';
        if (input.refund.amountMinor !== quote.suggestedRefundMinor && note === '') {
          throw errors.refundNoteRequired(quote.suggestedRefundMinor, input.refund.amountMinor);
        }
        if (input.refund.amountMinor > 0) {
          const paymentId = await this.recordPayment.recordIn(
            tx,
            {
              propertyId: reservation.propertyId,
              reservationId: reservation.id,
              kind: 'REFUND',
              method: input.refund.method,
              amountMinor: input.refund.amountMinor,
              reference: `cancel:${reservation.code}`,
            },
            actor,
            now,
          );
          refundResult = {
            amountMinor: input.refund.amountMinor,
            method: input.refund.method,
            paymentId,
          };
        }
        refundAudit = {
          quotedRefundMinor: quote.suggestedRefundMinor,
          refundMinor: input.refund.amountMinor,
          method: input.refund.method,
          note: note === '' ? null : note,
        };
      }

      const today = businessDate(property.timezone, now);

      const releasedNights: IsoDate[] = [];
      const retainedNights: IsoDate[] = [];
      const touchedRoomTypes = new Map<string, IsoDate[]>();

      for (const stay of reservation.stays) {
        const releasable = stay.nightDates.filter((night) => night >= today);
        const consumed = stay.nightDates.filter((night) => night < today);
        retainedNights.push(...consumed);

        if (releasable.length === 0) continue;

        // Lock before releasing, in the same date order the booking path uses.
        await this.inventory.lockDates(tx, stay.roomTypeId, releasable);
        const released = await this.inventory.release(tx, stay.roomTypeId, releasable, 1);
        if (released !== releasable.length) {
          // Would mean `booked` is lower than the reservations that reference
          // it — a data-integrity bug. Fail loudly instead of papering over it.
          throw errors.conflict('Inventory release did not match the nights held', {
            reservationId: reservation.id,
            stayId: stay.id,
            expected: releasable.length,
            released,
          });
        }

        releasedNights.push(...releasable);
        const existing = touchedRoomTypes.get(stay.roomTypeId) ?? [];
        touchedRoomTypes.set(stay.roomTypeId, [...existing, ...releasable]);
      }

      // Release any room the booking was holding. A cancelled stay must not
      // keep a room out of use — and the exclusion constraint that stops two
      // bookings sharing a room does not know about reservation status, so
      // leaving the assignment would block the room for those nights forever.
      const releasedRooms = await tx
        .update(reservationStays)
        .set({ assignedRoomId: null, updatedAt: now })
        .where(
          and(
            eq(reservationStays.organizationId, tenant.organizationId),
            eq(reservationStays.reservationId, reservation.id),
            isNotNull(reservationStays.assignedRoomId),
          ),
        );

      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'CANCELLED',
        { cancelledAt: now, cancellationReason: input.reason ?? 'Cancelled' },
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: reservation.propertyId,
        actor,
        action: 'reservation.cancelled',
        entityType: 'reservation',
        entityId: reservation.id,
        before: { status: reservation.status },
        after: {
          status: 'CANCELLED',
          releasedNights,
          retainedNights,
          roomsReleased: releasedRooms.rowCount ?? 0,
          ...(refundAudit ? { refund: refundAudit } : {}),
        },
        reason: input.reason ?? null,
      });

      const events: OutboxEventInput[] = [
        {
          type: EVENT_TYPES.RESERVATION_CANCELLED,
          organizationId: tenant.organizationId,
          propertyId: reservation.propertyId,
          aggregateType: 'reservation',
          aggregateId: reservation.id,
          payload: {
            reservationId: reservation.id,
            propertyId: reservation.propertyId,
            code: reservation.code,
            status: 'CANCELLED',
            channelId: null,
            affectedDates: releasedNights,
            refundPaymentId: refundResult?.paymentId ?? null,
          },
        },
        ...[...touchedRoomTypes.entries()].map(([roomTypeId, dates]) => {
          const sorted = [...dates].sort();
          const first = sorted[0] as IsoDate;
          const last = sorted[sorted.length - 1] as IsoDate;
          return {
            type: EVENT_TYPES.INVENTORY_CHANGED,
            organizationId: tenant.organizationId,
            propertyId: reservation.propertyId,
            aggregateType: 'inventory',
            aggregateId: roomTypeId,
            payload: {
              propertyId: reservation.propertyId,
              roomTypeId,
              from: first,
              to: last,
              reason: 'BOOKED_CHANGED' as const,
            },
          };
        }),
      ];
      await this.outbox.recordMany(tx, events);

      return {
        id: reservation.id,
        status: 'CANCELLED' as const,
        releasedNights,
        retainedNights,
        refund: refundResult,
      };
    });
  }
}
