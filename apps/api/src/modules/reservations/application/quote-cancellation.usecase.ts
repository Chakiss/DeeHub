import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { reservationStays } from '../../../database/schema';
import { cancellationDeadline } from '../../booking-engine/domain/cancellation-deadline';
import { policyOf, strictestPolicy } from '../../booking-engine/domain/strictest-policy';
import type { FolioPaymentMethod } from '../../folio/domain/folio';
import { GetFolioQuery } from '../../folio/application/get-folio.query';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { computeCancelQuote } from '../domain/cancellation-quote';
import { assertTransition } from '../domain/reservation-status';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';

export interface CancellationQuote {
  readonly policy: {
    readonly noticeHours: number;
    readonly refundPercent: number;
    readonly deadline: Date;
    readonly inTime: boolean;
  } | null;
  readonly totalMinor: number;
  /** Gross folio payments (voided rows excluded). */
  readonly paidMinor: number;
  readonly refundedMinor: number;
  readonly suggestedRefundMinor: number;
  /** Method of the largest live PAYMENT on the folio; null when nothing was paid. */
  readonly suggestedMethod: FolioPaymentMethod | null;
  readonly currency: string;
}

/**
 * What cancelling a booking would refund, per the terms frozen on its stays and
 * the money actually on the folio. A query: it writes nothing. The cancel use
 * case calls `quoteIn` inside its own transaction to recompute the figure on the
 * server rather than trusting one the client displayed.
 */
@Injectable()
export class QuoteCancellationUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly folio: GetFolioQuery,
  ) {}

  async execute(
    propertyId: string,
    reservationId: string,
    now: Date = new Date(),
  ): Promise<CancellationQuote> {
    return this.quoteIn(this.db, propertyId, reservationId, now);
  }

  async quoteIn(
    tx: Executor,
    propertyId: string,
    reservationId: string,
    now: Date,
  ): Promise<CancellationQuote> {
    const reservation = await this.reservations.findById(tx, reservationId);
    if (!reservation || reservation.propertyId !== propertyId) {
      throw errors.notFound('Reservation', reservationId);
    }
    // Only a booking that can still be cancelled has anything to quote.
    assertTransition(reservation.status, 'CANCELLED');

    const property = await this.propertyRepo.findProfile(tx, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);

    const stayRows = await tx
      .select({
        cancellationNoticeHours: reservationStays.cancellationNoticeHours,
        cancellationRefundPercent: reservationStays.cancellationRefundPercent,
      })
      .from(reservationStays)
      .where(
        and(
          eq(reservationStays.organizationId, requireTenant().organizationId),
          eq(reservationStays.reservationId, reservationId),
        ),
      );
    const policy = strictestPolicy(stayRows.map(policyOf));

    const checkIn = reservation.stays.map((stay) => stay.checkIn).sort()[0];
    const deadline =
      policy !== null && checkIn !== undefined
        ? cancellationDeadline({
            checkIn,
            checkInTime: property.checkInTime,
            timeZone: property.timezone,
            noticeHours: policy.noticeHours,
          })
        : null;

    const folio = await this.folio.load(tx, propertyId, reservationId);
    const paidMinor = folio.totals.paid.amount;
    const refundedMinor = folio.totals.refunded.amount;

    const quote = computeCancelQuote({
      policy,
      totalMinor: reservation.totalMinor,
      paidMinor,
      refundedMinor,
      deadline,
      now,
    });

    let largest: { method: FolioPaymentMethod; amountMinor: number } | null = null;
    for (const payment of folio.payments) {
      if (payment.kind !== 'PAYMENT' || payment.voidedAt !== null) continue;
      if (largest === null || payment.amountMinor > largest.amountMinor) {
        largest = { method: payment.method, amountMinor: payment.amountMinor };
      }
    }

    return {
      policy: quote.policy,
      totalMinor: reservation.totalMinor,
      paidMinor,
      refundedMinor,
      suggestedRefundMinor: quote.suggestedRefundMinor,
      suggestedMethod: largest?.method ?? null,
      currency: reservation.currency,
    };
  }
}
