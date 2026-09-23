import type { Executor } from '../../../database/executor';
import type { PaymentMethod } from './payment-gateway';

export type PaymentIntentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface PaymentIntentRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly provider: string;
  readonly providerChargeId: string;
  readonly method: PaymentMethod;
  readonly status: PaymentIntentStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly authorizeUri: string | null;
  readonly qrImageUri: string | null;
  readonly failureReason: string | null;
  readonly expiresAt: Date | null;
  readonly checkedAt: Date | null;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
}

export type NewPaymentIntent = Omit<
  PaymentIntentRecord,
  'status' | 'failureReason' | 'checkedAt' | 'settledAt' | 'createdAt'
> & { readonly status: PaymentIntentStatus };

/**
 * Payment attempts, organization-scoped like every repository (ADR-0001).
 *
 * `findByProviderCharge` is deliberately NOT tenant-scoped: a webhook carries
 * no tenant, only the provider's charge id, and that id is unique across the
 * table. The use case that receives it establishes the tenant from the row.
 */
export interface PaymentIntentRepository {
  insert(tx: Executor, record: NewPaymentIntent): Promise<void>;
  findById(
    tx: Executor,
    reservationId: string,
    intentId: string,
  ): Promise<PaymentIntentRecord | null>;
  findByProviderCharge(
    tx: Executor,
    provider: string,
    providerChargeId: string,
  ): Promise<PaymentIntentRecord | null>;
  /** Newest first. */
  listForReservation(tx: Executor, reservationId: string): Promise<readonly PaymentIntentRecord[]>;
  /**
   * Move a PENDING intent to its outcome. Returns 0 when it was no longer
   * PENDING — which is how a webhook delivered twice settles once.
   */
  settle(
    tx: Executor,
    intentId: string,
    outcome: { status: 'PAID' | 'FAILED' | 'EXPIRED'; failureReason?: string | null; at: Date },
  ): Promise<number>;
  touch(tx: Executor, intentId: string, checkedAt: Date): Promise<void>;
  /** PENDING intents whose provider deadline has passed. */
  expireOverdue(tx: Executor, now: Date): Promise<number>;
}

export const PAYMENT_INTENT_REPOSITORY = Symbol('PAYMENT_INTENT_REPOSITORY');
