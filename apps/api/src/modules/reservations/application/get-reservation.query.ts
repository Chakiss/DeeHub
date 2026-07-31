import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  physicalRooms,
  reservationStayNights,
  reservationStays,
  reservations,
  roomTypes,
} from '../../../database/schema';

export interface ReservationView {
  readonly id: string;
  readonly code: string;
  readonly propertyId: string;
  readonly status: string;
  readonly version: number;
  readonly currency: string;
  readonly source: string;
  readonly bookerName: string;
  readonly bookerEmail: string | null;
  readonly bookerPhone: string | null;
  readonly specialRequests: string | null;
  readonly createdAt: string;
  readonly checkedInAt: string | null;
  readonly checkedOutAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly total: { amount: number; currency: string };
  readonly subtotal: { amount: number; currency: string };
  readonly tax: { amount: number; currency: string };
  readonly serviceCharge: { amount: number; currency: string };
  readonly stays: readonly {
    readonly id: string;
    readonly roomTypeId: string;
    readonly roomTypeName: string;
    readonly ratePlanId: string;
    readonly checkIn: string;
    readonly checkOut: string;
    readonly adults: number;
    readonly children: number;
    readonly guestName: string | null;
    readonly assignedRoomId: string | null;
    readonly assignedRoomNumber: string | null;
    readonly subtotal: { amount: number; currency: string };
    readonly nights: readonly { readonly date: string; readonly amount: number }[];
  }[];
}

/**
 * One reservation, in full (api-spec.md §6.7).
 *
 * This runs its own SQL rather than reusing the repository's `findById`, which
 * returns a deliberately lean shape for the WRITE path — it is loaded on every
 * cancel, check-in and modification, and giving it a room type name and a
 * booker's phone number would make every write carry a read screen's needs.
 *
 * Reads take no transaction, no lock and raise no events, which is why they sit
 * outside the use cases entirely.
 */
@Injectable()
export class GetReservationQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async byId(reservationId: string): Promise<ReservationView | null> {
    const organizationId = requireOrganizationId();

    const rows = await this.db
      .select()
      .from(reservations)
      .where(
        and(eq(reservations.organizationId, organizationId), eq(reservations.id, reservationId)),
      )
      .limit(1);

    const reservation = rows[0];
    if (!reservation) return null;

    const stayRows = await this.db
      .select({
        id: reservationStays.id,
        roomTypeId: reservationStays.roomTypeId,
        roomTypeName: roomTypes.name,
        ratePlanId: reservationStays.ratePlanId,
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
        adults: reservationStays.adults,
        children: reservationStays.children,
        guestName: reservationStays.guestName,
        assignedRoomId: reservationStays.assignedRoomId,
        assignedRoomNumber: physicalRooms.roomNumber,
        subtotalMinor: reservationStays.subtotalMinor,
      })
      .from(reservationStays)
      .innerJoin(roomTypes, eq(roomTypes.id, reservationStays.roomTypeId))
      // LEFT: no room is assigned until check-in, and that is the normal state
      // for every future booking. An inner join would return nothing for them.
      .leftJoin(physicalRooms, eq(physicalRooms.id, reservationStays.assignedRoomId))
      .where(eq(reservationStays.reservationId, reservationId))
      .orderBy(asc(reservationStays.checkIn), asc(reservationStays.id));

    // Frozen per-night prices. The detail screen has to show what the guest was
    // quoted, which is not recoverable from today's rate plan.
    const nightRows = await this.db
      .select({
        stayId: reservationStayNights.stayId,
        date: reservationStayNights.date,
        amountMinor: reservationStayNights.amountMinor,
      })
      .from(reservationStayNights)
      .where(eq(reservationStayNights.reservationId, reservationId))
      .orderBy(asc(reservationStayNights.date));

    const nightsByStay = new Map<string, { date: string; amount: number }[]>();
    for (const night of nightRows) {
      const list = nightsByStay.get(night.stayId) ?? [];
      list.push({ date: night.date, amount: night.amountMinor });
      nightsByStay.set(night.stayId, list);
    }

    const currency = reservation.currency;

    return {
      id: reservation.id,
      code: reservation.code,
      propertyId: reservation.propertyId,
      status: reservation.status,
      // The client echoes this back when mutating, for optimistic locking.
      version: reservation.version,
      currency,
      source: reservation.source,
      // Who made the booking. The detail screen exists to answer "who is this
      // and what did they book", and the list only carries a name.
      bookerName: reservation.bookerName,
      bookerEmail: reservation.bookerEmail,
      bookerPhone: reservation.bookerPhone,
      specialRequests: reservation.specialRequests,
      createdAt: reservation.createdAt.toISOString(),
      checkedInAt: reservation.checkedInAt?.toISOString() ?? null,
      checkedOutAt: reservation.checkedOutAt?.toISOString() ?? null,
      cancelledAt: reservation.cancelledAt?.toISOString() ?? null,
      cancellationReason: reservation.cancellationReason,
      total: { amount: reservation.totalMinor, currency },
      subtotal: { amount: reservation.subtotalMinor, currency },
      tax: { amount: reservation.taxMinor, currency },
      serviceCharge: { amount: reservation.serviceChargeMinor, currency },
      stays: stayRows.map((stay) => ({
        id: stay.id,
        roomTypeId: stay.roomTypeId,
        roomTypeName: stay.roomTypeName,
        ratePlanId: stay.ratePlanId,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        adults: stay.adults,
        children: stay.children,
        guestName: stay.guestName,
        assignedRoomId: stay.assignedRoomId,
        assignedRoomNumber: stay.assignedRoomNumber,
        subtotal: { amount: stay.subtotalMinor, currency },
        nights: nightsByStay.get(stay.id) ?? [],
      })),
    };
  }
}
