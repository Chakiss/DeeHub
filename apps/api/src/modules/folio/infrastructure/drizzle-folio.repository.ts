import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { toIsoDate } from '@deehub/shared';
import {
  folioCharges,
  folioPayments,
  reservationStayNights,
  reservationStays,
  reservations,
  roomTypes,
  users,
} from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  ExtraChargeLine,
  FolioChargeKind,
  FolioPaymentKind,
  FolioPaymentMethod,
  PaymentLine,
  RoomChargeLine,
} from '../domain/folio';
import type {
  FolioRepository,
  FolioSubject,
  NewCharge,
  NewPayment,
} from '../domain/folio.repository';

@Injectable()
export class DrizzleFolioRepository implements FolioRepository {
  async findSubject(tx: Executor, reservationId: string): Promise<FolioSubject | null> {
    const rows = await tx
      .select({
        reservationId: reservations.id,
        propertyId: reservations.propertyId,
        organizationId: reservations.organizationId,
        code: reservations.code,
        status: reservations.status,
        bookerName: reservations.bookerName,
        currency: reservations.currency,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.organizationId, requireOrganizationId()),
          eq(reservations.id, reservationId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async findRoomCharges(tx: Executor, reservationId: string): Promise<readonly RoomChargeLine[]> {
    const rows = await tx
      .select({
        date: reservationStayNights.date,
        stayId: reservationStayNights.stayId,
        roomTypeName: roomTypes.name,
        amountMinor: reservationStayNights.amountMinor,
      })
      .from(reservationStayNights)
      .innerJoin(reservationStays, eq(reservationStays.id, reservationStayNights.stayId))
      .innerJoin(roomTypes, eq(roomTypes.id, reservationStayNights.roomTypeId))
      .where(
        and(
          eq(reservationStayNights.organizationId, requireOrganizationId()),
          eq(reservationStayNights.reservationId, reservationId),
        ),
      )
      // Chronological, then by stay: a two-room booking reads as two columns
      // of nights rather than an interleaved list.
      .orderBy(asc(reservationStayNights.date), asc(reservationStayNights.stayId));

    return rows.map((row) => ({
      date: toIsoDate(row.date),
      stayId: row.stayId,
      roomTypeName: row.roomTypeName,
      amountMinor: Number(row.amountMinor),
    }));
  }

  async findExtraCharges(tx: Executor, reservationId: string): Promise<readonly ExtraChargeLine[]> {
    const rows = await tx
      .select({
        id: folioCharges.id,
        kind: folioCharges.kind,
        description: folioCharges.description,
        amountMinor: folioCharges.amountMinor,
        taxable: folioCharges.taxable,
        businessDate: folioCharges.businessDate,
        postedAt: folioCharges.postedAt,
        postedBy: users.fullName,
        voidedAt: folioCharges.voidedAt,
        voidedReason: folioCharges.voidedReason,
      })
      .from(folioCharges)
      .leftJoin(users, eq(users.id, folioCharges.postedByUserId))
      .where(
        and(
          eq(folioCharges.organizationId, requireOrganizationId()),
          eq(folioCharges.reservationId, reservationId),
        ),
      )
      .orderBy(asc(folioCharges.postedAt));

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as FolioChargeKind,
      description: row.description,
      amountMinor: Number(row.amountMinor),
      taxable: row.taxable,
      businessDate: toIsoDate(row.businessDate),
      postedAt: row.postedAt,
      postedBy: row.postedBy,
      voidedAt: row.voidedAt,
      voidedReason: row.voidedReason,
    }));
  }

  async findPayments(tx: Executor, reservationId: string): Promise<readonly PaymentLine[]> {
    const rows = await tx
      .select({
        id: folioPayments.id,
        kind: folioPayments.kind,
        method: folioPayments.method,
        amountMinor: folioPayments.amountMinor,
        reference: folioPayments.reference,
        businessDate: folioPayments.businessDate,
        recordedAt: folioPayments.recordedAt,
        recordedBy: users.fullName,
        voidedAt: folioPayments.voidedAt,
        voidedReason: folioPayments.voidedReason,
      })
      .from(folioPayments)
      .leftJoin(users, eq(users.id, folioPayments.recordedByUserId))
      .where(
        and(
          eq(folioPayments.organizationId, requireOrganizationId()),
          eq(folioPayments.reservationId, reservationId),
        ),
      )
      .orderBy(asc(folioPayments.recordedAt));

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as FolioPaymentKind,
      method: row.method as FolioPaymentMethod,
      amountMinor: Number(row.amountMinor),
      reference: row.reference,
      businessDate: toIsoDate(row.businessDate),
      recordedAt: row.recordedAt,
      recordedBy: row.recordedBy,
      voidedAt: row.voidedAt,
      voidedReason: row.voidedReason,
    }));
  }

  async insertCharge(tx: Executor, charge: NewCharge): Promise<void> {
    await tx.insert(folioCharges).values(charge);
  }

  async insertPayment(tx: Executor, payment: NewPayment): Promise<void> {
    await tx.insert(folioPayments).values(payment);
  }

  async voidCharge(
    tx: Executor,
    chargeId: string,
    reservationId: string,
    by: { userId: string | null; reason: string; at: Date },
  ): Promise<boolean> {
    const result = await tx
      .update(folioCharges)
      .set({ voidedAt: by.at, voidedReason: by.reason, voidedByUserId: by.userId })
      .where(
        and(
          eq(folioCharges.organizationId, requireOrganizationId()),
          eq(folioCharges.id, chargeId),
          // Belt and braces: the id alone would let a charge be voided through
          // a reservation it does not belong to.
          eq(folioCharges.reservationId, reservationId),
          isNull(folioCharges.voidedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  async voidPayment(
    tx: Executor,
    paymentId: string,
    reservationId: string,
    by: { userId: string | null; reason: string; at: Date },
  ): Promise<boolean> {
    const result = await tx
      .update(folioPayments)
      .set({ voidedAt: by.at, voidedReason: by.reason, voidedByUserId: by.userId })
      .where(
        and(
          eq(folioPayments.organizationId, requireOrganizationId()),
          eq(folioPayments.id, paymentId),
          eq(folioPayments.reservationId, reservationId),
          isNull(folioPayments.voidedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }
}
