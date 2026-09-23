import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import {
  reservationStayNights,
  reservationStays,
  reservations,
  roomTypes,
} from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  PAYMENT_INTENT_REPOSITORY,
  type PaymentIntentRepository,
} from '../domain/payment-intent.repository';

export interface PublicBooking {
  readonly reservationId: string;
  readonly code: string;
  readonly status: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly serviceChargeMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly bookerName: string;
  readonly holdExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly stays: readonly {
    readonly roomTypeName: string;
    readonly adults: number;
    readonly children: number;
    readonly nights: readonly { readonly date: IsoDate; readonly amountMinor: number }[];
  }[];
  readonly payment: {
    readonly intentId: string;
    readonly method: string;
    readonly status: string;
  } | null;
}

/**
 * What a guest may know about their own booking, and only their own.
 *
 * The code alone is not enough: it is printed on a screen, quoted on the
 * phone, and six characters long. The email it was booked with is the second
 * factor — cheap for the guest, who has it in the confirmation, and opaque to
 * a stranger walking the code space. A mismatch is a 404, not a 403: whether
 * a code exists is not a stranger's business either.
 */
@Injectable()
export class PublicBookingQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PAYMENT_INTENT_REPOSITORY) private readonly intents: PaymentIntentRepository,
  ) {}

  async findByCodeAndEmail(
    propertyId: string,
    code: string,
    email: string,
  ): Promise<PublicBooking | null> {
    const organizationId = requireOrganizationId();
    const rows = await this.db
      .select({
        id: reservations.id,
        code: reservations.code,
        status: reservations.status,
        currency: reservations.currency,
        subtotalMinor: reservations.subtotalMinor,
        serviceChargeMinor: reservations.serviceChargeMinor,
        taxMinor: reservations.taxMinor,
        totalMinor: reservations.totalMinor,
        bookerName: reservations.bookerName,
        holdExpiresAt: reservations.holdExpiresAt,
        createdAt: reservations.createdAt,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.organizationId, organizationId),
          eq(reservations.propertyId, propertyId),
          sql`upper(${reservations.code}) = upper(${code})`,
          sql`lower(${reservations.bookerEmail}) = lower(${email.trim()})`,
        ),
      )
      .limit(1);
    const reservation = rows[0];
    if (!reservation) return null;

    const stayRows = await this.db
      .select({
        id: reservationStays.id,
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
        adults: reservationStays.adults,
        children: reservationStays.children,
        roomTypeName: roomTypes.name,
      })
      .from(reservationStays)
      .innerJoin(roomTypes, eq(roomTypes.id, reservationStays.roomTypeId))
      .where(eq(reservationStays.reservationId, reservation.id))
      .orderBy(asc(reservationStays.checkIn));

    const nightRows = await this.db
      .select({
        stayId: reservationStayNights.stayId,
        date: reservationStayNights.date,
        amountMinor: reservationStayNights.amountMinor,
      })
      .from(reservationStayNights)
      .innerJoin(reservationStays, eq(reservationStays.id, reservationStayNights.stayId))
      .where(eq(reservationStays.reservationId, reservation.id))
      .orderBy(asc(reservationStayNights.date));

    const intents = await this.intents.listForReservation(this.db, reservation.id);
    // The one that matters: a PAID one if any, else the newest still pending.
    const paid = intents.find((intent) => intent.status === 'PAID');
    const pending = intents.find((intent) => intent.status === 'PENDING');
    const shown = paid ?? pending ?? intents[0] ?? null;

    const checkIns = stayRows.map((stay) => toIsoDate(stay.checkIn));
    const checkOuts = stayRows.map((stay) => toIsoDate(stay.checkOut));

    return {
      reservationId: reservation.id,
      code: reservation.code,
      status: reservation.status,
      currency: reservation.currency,
      subtotalMinor: reservation.subtotalMinor,
      serviceChargeMinor: reservation.serviceChargeMinor,
      taxMinor: reservation.taxMinor,
      totalMinor: reservation.totalMinor,
      bookerName: reservation.bookerName,
      holdExpiresAt: reservation.holdExpiresAt,
      createdAt: reservation.createdAt,
      checkIn: checkIns.reduce((a, b) => (a < b ? a : b)),
      checkOut: checkOuts.reduce((a, b) => (a > b ? a : b)),
      stays: stayRows.map((stay) => ({
        roomTypeName: stay.roomTypeName,
        adults: stay.adults,
        children: stay.children,
        nights: nightRows
          .filter((night) => night.stayId === stay.id)
          .map((night) => ({ date: toIsoDate(night.date), amountMinor: night.amountMinor })),
      })),
      payment: shown ? { intentId: shown.id, method: shown.method, status: shown.status } : null,
    };
  }

  /**
   * PENDING bookings whose hold has not lapsed, made under this email at this
   * property. The cap on it is the one defence a hold has against a script
   * that books a small hotel out without paying.
   */
  async openHoldsFor(propertyId: string, email: string, now: Date): Promise<number> {
    const organizationId = requireOrganizationId();
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        and(
          eq(reservations.organizationId, organizationId),
          eq(reservations.propertyId, propertyId),
          eq(reservations.status, 'PENDING'),
          gt(reservations.holdExpiresAt, now),
          sql`lower(${reservations.bookerEmail}) = lower(${email.trim()})`,
        ),
      );
    return rows[0]?.count ?? 0;
  }
}
