import { Inject, Injectable, Logger } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { ENV, type Env } from '../../../config/env';
import { newId } from '../../../common/ids';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../../reservations/domain/reservation.repository';
import {
  PAYMENT_INTENT_REPOSITORY,
  type PaymentIntentRecord,
  type PaymentIntentRepository,
} from '../domain/payment-intent.repository';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type PaymentMethod,
} from '../domain/payment-gateway';
import type { PublicProperty } from './public-property.resolver';
import { SettlePaymentUseCase, type SettleResult } from './settle-payment.usecase';

export interface StartPaymentInput {
  readonly reservationCode: string;
  readonly method: PaymentMethod;
  /** CARD only: the one-time token from the provider's browser library. */
  readonly token?: string;
  /** Where the provider sends the guest back after a 3-D Secure challenge. */
  readonly returnUri: string;
}

export type StartPaymentResult =
  | { readonly status: 'PAID'; readonly intentId: string; readonly reservationStatus: string }
  | {
      readonly status: 'PENDING';
      readonly intentId: string;
      readonly method: PaymentMethod;
      readonly authorizeUri: string | null;
      readonly qrImageUri: string | null;
      readonly expiresAt: string | null;
    }
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | { readonly status: 'DECLINED'; readonly reason: string; readonly retryable: boolean };

/**
 * How long a booking is held once a payment has been started. A PromptPay QR
 * and a bank's 3-D Secure page both take longer than the fifteen minutes a
 * fresh hold gets; a guest mid-payment must not lose the room to the sweeper.
 */
const PAYING_HOLD_MS = 30 * 60 * 1000;

/**
 * Begin paying for a held booking.
 *
 * **The amount is the booking's total, read here, never sent.** The whole
 * stay, not a fraction: a deposit percentage needs a policy no rate plan
 * carries yet (decisions-pending-review §17).
 *
 * **Only a PENDING booking.** A CONFIRMED one has been paid or accepted, and
 * charging against it from a public endpoint with nothing but a code would
 * be a way to bill a stranger twice.
 *
 * **One open attempt at a time.** If a PromptPay QR is already waiting, the
 * same QR is returned rather than a second charge started: two live charges
 * for one booking is how a guest pays twice.
 *
 * The charge happens OUTSIDE any transaction: a bank inside a database
 * transaction is the shape of outage that takes a booking system down with
 * it. A charge that finished in the first round trip is then applied by the
 * same code every other outcome goes through.
 */
@Injectable()
export class StartPaymentUseCase {
  private readonly logger = new Logger(StartPaymentUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    @Inject(PAYMENT_INTENT_REPOSITORY) private readonly intents: PaymentIntentRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly settle: SettlePaymentUseCase,
  ) {}

  async execute(
    property: PublicProperty,
    input: StartPaymentInput,
    now: Date = new Date(),
  ): Promise<StartPaymentResult> {
    const reservation = await this.reservations.findByCode(
      this.db,
      property.propertyId,
      input.reservationCode,
    );
    if (!reservation) throw errors.notFound('Reservation', input.reservationCode);

    if (reservation.status !== 'PENDING') {
      throw errors.conflict(`This booking is ${reservation.status} and is not awaiting payment`, {
        code: input.reservationCode,
        status: reservation.status,
      });
    }

    if (!this.gateway.isConfigured()) {
      return { status: 'UNAVAILABLE', reason: 'This hotel does not take online payments yet' };
    }
    if (!this.gateway.methods().includes(input.method)) {
      throw errors.validation(`${input.method} is not available at this hotel`);
    }
    this.assertReturnUri(input.returnUri);

    const open = (await this.intents.listForReservation(this.db, reservation.id)).find(
      (intent) =>
        intent.status === 'PENDING' && (intent.expiresAt === null || intent.expiresAt > now),
    );
    if (open) return pending(open);

    const outcome = await this.gateway.startCharge({
      method: input.method,
      ...(input.token ? { token: input.token } : {}),
      amountMinor: reservation.totalMinor,
      currency: reservation.currency,
      description: `${property.name} — booking ${reservation.code}`,
      reference: reservation.code,
      returnUri: input.returnUri,
    });

    if (outcome.status === 'UNAVAILABLE') return outcome;
    if (outcome.status === 'DECLINED') {
      this.logger.warn(`Payment declined for ${reservation.code}: ${outcome.reason}`);
      // The booking is left PENDING, holding its inventory until the hold
      // expires. A guest whose first card is refused usually has a second one.
      return outcome;
    }

    const intent: PaymentIntentRecord = {
      id: newId(),
      organizationId: property.organizationId,
      propertyId: property.propertyId,
      reservationId: reservation.id,
      provider: this.gateway.provider,
      providerChargeId: outcome.providerReference,
      method: input.method,
      status: 'PENDING',
      amountMinor: reservation.totalMinor,
      currency: reservation.currency,
      authorizeUri: outcome.status === 'PENDING' ? outcome.authorizeUri : null,
      qrImageUri: outcome.status === 'PENDING' ? outcome.qrImageUri : null,
      failureReason: null,
      expiresAt:
        outcome.status === 'PENDING' && outcome.expiresAt
          ? outcome.expiresAt
          : new Date(now.getTime() + PAYING_HOLD_MS),
      checkedAt: null,
      settledAt: null,
      createdAt: now,
    };

    await this.db.transaction(async (tx) => {
      await this.intents.insert(tx, intent);
      // Never shorter than the provider's own deadline: a QR that is still
      // payable must not point at a room the sweeper gave away.
      const until = new Date(
        Math.max(now.getTime() + PAYING_HOLD_MS, intent.expiresAt?.getTime() ?? 0),
      );
      await this.reservations.extendHold(tx, reservation.id, until);
    });

    if (outcome.status === 'PAID') {
      const settled: SettleResult = await this.settle.apply(intent, { status: 'PAID' }, now);
      if (settled.outcome === 'PAID') {
        return {
          status: 'PAID',
          intentId: intent.id,
          reservationStatus: settled.reservationStatus,
        };
      }
      // Paid but the booking moved underneath us; the page shows the status
      // it can read, and the audit trail names the charge to refund.
      return { status: 'PAID', intentId: intent.id, reservationStatus: 'UNCONFIRMABLE' };
    }

    return pending(intent);
  }

  private assertReturnUri(uri: string): void {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw errors.validation('returnUri must be an absolute URL');
    }
    const base = this.env.BOOKING_WEB_URL;
    if (base) {
      if (!uri.startsWith(base.replace(/\/+$/, ''))) {
        throw errors.validation('returnUri must be on the booking site');
      }
      return;
    }
    if (
      parsed.protocol !== 'https:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      throw errors.validation('returnUri must be https');
    }
  }
}

function pending(intent: PaymentIntentRecord): StartPaymentResult {
  return {
    status: 'PENDING',
    intentId: intent.id,
    method: intent.method,
    authorizeUri: intent.authorizeUri,
    qrImageUri: intent.qrImageUri,
    expiresAt: intent.expiresAt?.toISOString() ?? null,
  };
}
