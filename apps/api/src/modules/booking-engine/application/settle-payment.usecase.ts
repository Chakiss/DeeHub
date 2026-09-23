import { Inject, Injectable, Logger } from '@nestjs/common';
import { businessDate, EVENT_TYPES } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { FOLIO_REPOSITORY, type FolioRepository } from '../../folio/domain/folio.repository';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../../reservations/domain/reservation.repository';
import {
  PAYMENT_INTENT_REPOSITORY,
  type PaymentIntentRecord,
  type PaymentIntentRepository,
} from '../domain/payment-intent.repository';
import { PAYMENT_GATEWAY, type ChargeState, type PaymentGateway } from '../domain/payment-gateway';

/** The system, acting on a guest's instruction. Nobody at the hotel did this. */
export const GUEST_ACTOR: AuditActor = { type: 'SYSTEM', id: null, label: 'booking engine' };

/** A polling page asks every few seconds; the provider is asked at most this often. */
const RECHECK_AFTER_MS = 3_000;

export type SettleResult =
  | { readonly outcome: 'PAID'; readonly reservationStatus: string }
  | { readonly outcome: 'PENDING' }
  | { readonly outcome: 'FAILED'; readonly reason: string }
  | { readonly outcome: 'EXPIRED' }
  /**
   * Money arrived for a booking that could no longer be confirmed — the hold
   * lapsed, or the desk cancelled — in the seconds between. Loud, because it
   * needs a person to refund it.
   */
  | { readonly outcome: 'PAID_UNCONFIRMABLE'; readonly reservationStatus: string };

/**
 * Turn what the provider says into what the hotel's books say.
 *
 * Called from three places with one rule: **the provider's answer is the
 * only thing that confirms a booking.** A webhook body is a claim — anybody
 * can POST one — so a webhook is only a prompt to go and ask. The booking
 * page's poll asks too. And a charge that finished in the first round trip
 * is applied by the same code, so there is exactly one path from "paid" to
 * CONFIRMED.
 *
 * Idempotent by construction: the intent row moves out of PENDING exactly
 * once (`settle` returns 0 otherwise), and everything that follows — the
 * folio payment, the status change, the confirmation email — happens inside
 * that same transaction. A webhook delivered twice, or racing the poll,
 * confirms once.
 */
@Injectable()
export class SettlePaymentUseCase {
  private readonly logger = new Logger(SettlePaymentUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PAYMENT_INTENT_REPOSITORY) private readonly intents: PaymentIntentRepository,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    @Inject(FOLIO_REPOSITORY) private readonly folio: FolioRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Ask the provider, then apply. For the poll and for a returning 3-D Secure guest. */
  async check(intent: PaymentIntentRecord, now: Date = new Date()): Promise<SettleResult> {
    if (intent.status !== 'PENDING') return this.resultOf(intent);
    if (intent.checkedAt && now.getTime() - intent.checkedAt.getTime() < RECHECK_AFTER_MS) {
      return { outcome: 'PENDING' };
    }
    if (intent.expiresAt && intent.expiresAt <= now) {
      return this.apply(intent, { status: 'EXPIRED' }, now);
    }

    let state: ChargeState;
    try {
      state = await this.gateway.fetchCharge(intent.providerChargeId);
    } catch (error) {
      // The provider is unreachable; say "still pending" and let the next
      // poll try. Failing the guest's page over our network is not an answer.
      this.logger.warn(`Could not check ${intent.providerChargeId}: ${String(error)}`);
      await this.intents.touch(this.db, intent.id, now);
      return { outcome: 'PENDING' };
    }
    return this.apply(intent, state, now);
  }

  /**
   * A webhook named a charge. The tenant is established from the row, since a
   * webhook carries none; an unknown charge is logged and dropped, because
   * answering anything but 200 makes the provider retry it forever.
   */
  async checkByProviderCharge(providerChargeId: string, now: Date = new Date()): Promise<void> {
    const intent = await this.intents.findByProviderCharge(
      this.db,
      this.gateway.provider,
      providerChargeId,
    );
    if (!intent) {
      this.logger.warn(`Webhook for unknown ${this.gateway.provider} charge ${providerChargeId}`);
      return;
    }
    await runWithTenant(
      {
        organizationId: intent.organizationId,
        userId: null,
        propertyId: intent.propertyId,
        requestId: `webhook-${providerChargeId}`,
      },
      // The webhook is a prompt, never a fact: `check` asks the provider.
      () => this.check({ ...intent, checkedAt: null }, now),
    );
  }

  /** Apply a state the provider has ALREADY given us — the first round trip, or `check`. */
  async apply(
    intent: PaymentIntentRecord,
    state: ChargeState,
    now: Date = new Date(),
  ): Promise<SettleResult> {
    if (state.status === 'PENDING') {
      await this.intents.touch(this.db, intent.id, now);
      return { outcome: 'PENDING' };
    }

    if (state.status !== 'PAID') {
      const moved = await this.intents.settle(this.db, intent.id, {
        status: state.status,
        failureReason: state.status === 'FAILED' ? state.reason : null,
        at: now,
      });
      if (moved === 0) return this.resultOf(intent);
      return state.status === 'FAILED'
        ? { outcome: 'FAILED', reason: state.reason }
        : { outcome: 'EXPIRED' };
    }

    return this.db.transaction(async (tx) => {
      // Exactly-once: whoever moves the row out of PENDING does the rest.
      const moved = await this.intents.settle(tx, intent.id, { status: 'PAID', at: now });
      if (moved === 0) return this.resultOf(intent);

      const reservation = await this.reservations.findById(tx, intent.reservationId);
      if (!reservation) {
        throw new Error(`Payment ${intent.id} names a reservation that does not exist`);
      }

      // Money is recorded whatever the booking's state: the folio is where
      // the desk sees what was taken, and a refund starts from it.
      await this.folio.insertPayment(tx, {
        id: newId(),
        organizationId: intent.organizationId,
        propertyId: intent.propertyId,
        reservationId: reservation.id,
        kind: 'PAYMENT',
        method: intent.method,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        // The provider's own id, so a settlement report reconciles against ours.
        reference: intent.providerChargeId,
        businessDate: businessDate(
          (await this.properties.findProperty(tx, intent.propertyId))?.timezone ?? 'Asia/Bangkok',
          now,
        ),
        // Nobody at the hotel took this. Attributing it to a person would put
        // somebody else's name on a cashier reconciliation.
        recordedByUserId: null,
      });

      if (reservation.status !== 'PENDING') {
        this.logger.error(
          `Paid ${intent.providerChargeId} for ${reservation.code}, which is ${reservation.status} — refund by hand`,
        );
        await this.audit.record(tx, {
          organizationId: intent.organizationId,
          propertyId: intent.propertyId,
          actor: GUEST_ACTOR,
          action: 'booking_engine.payment_unconfirmable',
          entityType: 'reservation',
          entityId: reservation.id,
          after: {
            amountMinor: intent.amountMinor,
            providerReference: intent.providerChargeId,
            reservationStatus: reservation.status,
          },
          reason: 'Money arrived for a booking that was no longer awaiting payment',
        });
        return { outcome: 'PAID_UNCONFIRMABLE', reservationStatus: reservation.status };
      }

      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        reservation.version,
        'CONFIRMED',
      );
      if (updated !== 1) {
        // Somebody moved the booking between our read and our write, inside
        // this transaction's lifetime. Roll everything back — the intent row
        // too — and let the next check try again against the new state.
        throw new Error(`Reservation ${reservation.code} changed while being confirmed`);
      }

      await this.audit.record(tx, {
        organizationId: intent.organizationId,
        propertyId: intent.propertyId,
        actor: GUEST_ACTOR,
        action: 'booking_engine.payment_taken',
        entityType: 'reservation',
        entityId: reservation.id,
        after: {
          amountMinor: intent.amountMinor,
          method: intent.method,
          providerReference: intent.providerChargeId,
          status: 'CONFIRMED',
        },
      });

      // The relay turns this into the guest's confirmation email.
      await this.outbox.record(tx, {
        type: EVENT_TYPES.RESERVATION_STATUS_CHANGED,
        organizationId: intent.organizationId,
        propertyId: intent.propertyId,
        aggregateType: 'reservation',
        aggregateId: reservation.id,
        payload: {
          reservationId: reservation.id,
          propertyId: intent.propertyId,
          code: reservation.code,
          status: 'CONFIRMED',
          channelId: null,
          affectedDates: reservation.stays.flatMap((stay) => stay.nightDates),
        },
      });

      return { outcome: 'PAID', reservationStatus: 'CONFIRMED' };
    });
  }

  private resultOf(intent: PaymentIntentRecord): SettleResult {
    switch (intent.status) {
      case 'PAID':
        return { outcome: 'PAID', reservationStatus: 'CONFIRMED' };
      case 'FAILED':
        return {
          outcome: 'FAILED',
          reason: intent.failureReason ?? 'The payment did not go through',
        };
      case 'EXPIRED':
        return { outcome: 'EXPIRED' };
      default:
        return { outcome: 'PENDING' };
    }
  }
}
