import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { paymentIntents } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type {
  NewPaymentIntent,
  PaymentIntentRecord,
  PaymentIntentRepository,
} from '../domain/payment-intent.repository';

function present(row: typeof paymentIntents.$inferSelect): PaymentIntentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    reservationId: row.reservationId,
    provider: row.provider,
    providerChargeId: row.providerChargeId,
    method: row.method as PaymentIntentRecord['method'],
    status: row.status as PaymentIntentRecord['status'],
    amountMinor: row.amountMinor,
    currency: row.currency,
    authorizeUri: row.authorizeUri,
    qrImageUri: row.qrImageUri,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt,
    checkedAt: row.checkedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class DrizzlePaymentIntentRepository implements PaymentIntentRepository {
  async insert(tx: Executor, record: NewPaymentIntent): Promise<void> {
    await tx.insert(paymentIntents).values(record);
  }

  async findById(
    tx: Executor,
    reservationId: string,
    intentId: string,
  ): Promise<PaymentIntentRecord | null> {
    const rows = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.organizationId, requireOrganizationId()),
          eq(paymentIntents.reservationId, reservationId),
          eq(paymentIntents.id, intentId),
        ),
      )
      .limit(1);
    return rows[0] ? present(rows[0]) : null;
  }

  async findByProviderCharge(
    tx: Executor,
    provider: string,
    providerChargeId: string,
  ): Promise<PaymentIntentRecord | null> {
    const rows = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.provider, provider),
          eq(paymentIntents.providerChargeId, providerChargeId),
        ),
      )
      .limit(1);
    return rows[0] ? present(rows[0]) : null;
  }

  async listForReservation(
    tx: Executor,
    reservationId: string,
  ): Promise<readonly PaymentIntentRecord[]> {
    const rows = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.organizationId, requireOrganizationId()),
          eq(paymentIntents.reservationId, reservationId),
        ),
      )
      .orderBy(desc(paymentIntents.createdAt));
    return rows.map(present);
  }

  async settle(
    tx: Executor,
    intentId: string,
    outcome: { status: 'PAID' | 'FAILED' | 'EXPIRED'; failureReason?: string | null; at: Date },
  ): Promise<number> {
    const result = await tx
      .update(paymentIntents)
      .set({
        status: outcome.status,
        failureReason: outcome.failureReason ?? null,
        settledAt: outcome.at,
        checkedAt: outcome.at,
        updatedAt: outcome.at,
      })
      .where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.status, 'PENDING')))
      .returning({ id: paymentIntents.id });
    return result.length;
  }

  async touch(tx: Executor, intentId: string, checkedAt: Date): Promise<void> {
    await tx
      .update(paymentIntents)
      .set({ checkedAt, updatedAt: checkedAt })
      .where(eq(paymentIntents.id, intentId));
  }

  async expireOverdue(tx: Executor, now: Date): Promise<number> {
    const result = await tx
      .update(paymentIntents)
      .set({ status: 'EXPIRED', settledAt: now, updatedAt: now })
      .where(and(eq(paymentIntents.status, 'PENDING'), lt(paymentIntents.expiresAt, now)))
      .returning({ id: paymentIntents.id });
    return result.length;
  }
}
