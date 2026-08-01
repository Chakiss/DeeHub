import { Inject, Injectable, Logger } from '@nestjs/common';
import { businessDate, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { FOLIO_REPOSITORY, type FolioRepository } from '../../folio/domain/folio.repository';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../../reservations/domain/reservation.repository';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../domain/payment-gateway';
import type { PublicProperty } from './public-property.resolver';

export interface TakeDepositInput {
  readonly reservationCode: string;
  /** One-time token from the provider's client library. Never a card number. */
  readonly token: string;
}

export type TakeDepositResult =
  | { readonly status: 'PAID'; readonly amountMinor: number; readonly reservationStatus: string }
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | { readonly status: 'DECLINED'; readonly reason: string; readonly retryable: boolean };

/** The system, acting on a guest's instruction. Nobody at the hotel did this. */
const GUEST_ACTOR: AuditActor = {
  type: 'SYSTEM',
  id: null,
  label: 'booking engine',
};

/**
 * Charge the card a guest gave the booking page, and confirm their booking.
 *
 * **The deposit is the whole stay, not a fraction of it.** A percentage deposit
 * needs a policy — how much, per rate plan, refundable until when — and none of
 * that exists on a rate plan yet. Charging the full amount is the one figure
 * that is unambiguous and already computed, and a hotel that wants 30% can put
 * a non-refundable derived rate plan in front of it. Say what the rule should
 * be and it becomes a field.
 *
 * **Payment lands on the folio, not in a column of its own.** The guest's
 * account already knows how to hold money taken by method, and a deposit
 * recorded anywhere else would be a second ledger the front desk cannot see
 * when the guest arrives asking what they still owe.
 *
 * **A booking is only confirmed by a successful charge.** With no provider
 * configured the booking stays PENDING and the response says so, which is how
 * most small Thai hotels already work — bank transfer, then a human confirms.
 * Pretending the card was declined would be a lie about a hotel's own setup.
 */
@Injectable()
export class TakeDepositUseCase {
  private readonly logger = new Logger(TakeDepositUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FOLIO_REPOSITORY) private readonly folio: FolioRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly audit: AuditService,
  ) {}

  async execute(
    property: PublicProperty,
    input: TakeDepositInput,
    now: Date = new Date(),
  ): Promise<TakeDepositResult> {
    const reservation = await this.reservations.findByCode(
      this.db,
      property.propertyId,
      input.reservationCode,
    );
    if (!reservation) throw errors.notFound('Reservation', input.reservationCode);

    /*
     * Only a booking that is still waiting for money. A CONFIRMED one has
     * already been paid or accepted by the hotel, and charging a card against
     * it from a public endpoint — with nothing but a booking code — would be a
     * way to bill a stranger's card twice.
     */
    if (reservation.status !== 'PENDING') {
      throw errors.conflict(`This booking is ${reservation.status} and is not awaiting payment`, {
        code: input.reservationCode,
        status: reservation.status,
      });
    }

    if (!this.gateway.isConfigured()) {
      return {
        status: 'UNAVAILABLE',
        reason: 'This hotel does not take card payments online yet',
      };
    }

    // The charge happens OUTSIDE any transaction. Holding a database
    // transaction open across a call to a bank puts a slow third party inside
    // it — the shape of outage that takes a booking system down with it.
    const outcome = await this.gateway.charge({
      token: input.token,
      amountMinor: reservation.totalMinor,
      currency: reservation.currency,
      description: `${property.name} — booking ${reservation.code}`,
      reference: reservation.code,
    });

    if (outcome.status === 'UNAVAILABLE') {
      return { status: 'UNAVAILABLE', reason: outcome.reason };
    }

    if (outcome.status === 'DECLINED') {
      this.logger.warn(`Deposit declined for ${reservation.code}: ${outcome.reason}`);
      // The booking is left PENDING, holding its inventory until the hold
      // expires. A guest whose first card is refused usually has a second one.
      return { status: 'DECLINED', reason: outcome.reason, retryable: outcome.retryable };
    }

    await this.db.transaction(async (tx) => {
      await this.folio.insertPayment(tx, {
        id: newId(),
        organizationId: property.organizationId,
        propertyId: property.propertyId,
        reservationId: reservation.id,
        kind: 'PAYMENT',
        method: 'CARD',
        amountMinor: reservation.totalMinor,
        currency: reservation.currency,
        // The provider's own id, so a settlement report reconciles against ours.
        reference: outcome.providerReference,
        businessDate: businessDate(property.timezone, now),
        // Nobody at the hotel took this. Attributing it to a person would put
        // somebody else's name on a cashier reconciliation.
        recordedByUserId: null,
      });

      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        reservation.version,
        'CONFIRMED',
      );
      if (updated !== 1) {
        /*
         * Somebody changed the booking between the charge and this write —
         * realistically the hold expiring, or the desk cancelling it. The
         * transaction rolls back, so the payment row goes with it; the money is
         * still taken at the provider and has to be reconciled by hand. Loud,
         * because that is the one case here that needs a person.
         */
        throw errors.conflict(
          'The booking changed while the payment was being taken. The card was charged — ' +
            `reconcile ${outcome.providerReference} by hand.`,
          { code: reservation.code, providerReference: outcome.providerReference },
        );
      }

      await this.audit.record(tx, {
        organizationId: property.organizationId,
        propertyId: property.propertyId,
        actor: GUEST_ACTOR,
        action: 'booking_engine.deposit_taken',
        entityType: 'reservation',
        entityId: reservation.id,
        after: {
          amountMinor: reservation.totalMinor,
          providerReference: outcome.providerReference,
          status: 'CONFIRMED',
        },
      });
    });

    return {
      status: 'PAID',
      amountMinor: reservation.totalMinor,
      reservationStatus: 'CONFIRMED',
    };
  }
}
