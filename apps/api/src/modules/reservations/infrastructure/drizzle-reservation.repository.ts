import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { toIsoDate, type IsoDate } from '@deehub/shared';
import { reservationStayNights, reservationStays, reservations } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { ReservationStatus } from '../domain/reservation-status';
import type {
  LoadedReservation,
  ReservationRecord,
  ReservationRepository,
} from '../domain/reservation.repository';

@Injectable()
export class DrizzleReservationRepository implements ReservationRepository {
  async insert(tx: Executor, record: ReservationRecord): Promise<void> {
    await tx.insert(reservations).values({
      id: record.id,
      organizationId: record.organizationId,
      propertyId: record.propertyId,
      code: record.code,
      status: record.status,
      source: record.source,
      channelId: record.channelId,
      guestId: record.guestId,
      bookerName: record.bookerName,
      bookerEmail: record.bookerEmail,
      bookerPhone: record.bookerPhone,
      currency: record.currency,
      subtotalMinor: record.subtotalMinor,
      taxMinor: record.taxMinor,
      serviceChargeMinor: record.serviceChargeMinor,
      totalMinor: record.totalMinor,
      holdExpiresAt: record.holdExpiresAt,
      specialRequests: record.specialRequests,
    });

    if (record.stays.length === 0) return;

    await tx.insert(reservationStays).values(
      record.stays.map((stay) => ({
        id: stay.id,
        organizationId: record.organizationId,
        propertyId: record.propertyId,
        reservationId: record.id,
        roomTypeId: stay.roomTypeId,
        ratePlanId: stay.ratePlanId,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        adults: stay.adults,
        children: stay.children,
        guestName: stay.guestName,
        subtotalMinor: stay.subtotalMinor,
      })),
    );

    // Nights carry propertyId and roomTypeId denormalized so reconciliation
    // and occupancy reports never have to join upward (docs/database.md §8).
    const nights = record.stays.flatMap((stay) =>
      stay.nights.map((night) => ({
        stayId: stay.id,
        date: night.date,
        organizationId: record.organizationId,
        reservationId: record.id,
        propertyId: record.propertyId,
        roomTypeId: stay.roomTypeId,
        amountMinor: night.amountMinor,
        currency: night.currency,
      })),
    );

    if (nights.length > 0) {
      await tx.insert(reservationStayNights).values(nights);
    }
  }

  async findById(tx: Executor, reservationId: string): Promise<LoadedReservation | null> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        id: reservations.id,
        organizationId: reservations.organizationId,
        propertyId: reservations.propertyId,
        code: reservations.code,
        status: reservations.status,
        version: reservations.version,
        currency: reservations.currency,
        totalMinor: reservations.totalMinor,
      })
      .from(reservations)
      .where(
        and(eq(reservations.id, reservationId), eq(reservations.organizationId, organizationId)),
      )
      .limit(1);

    const header = rows[0];
    if (!header) return null;

    return {
      ...header,
      status: header.status as ReservationStatus,
      stays: await this.loadStays(tx, reservationId),
    };
  }

  async findByCode(
    tx: Executor,
    propertyId: string,
    code: string,
  ): Promise<LoadedReservation | null> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          eq(reservations.organizationId, organizationId),
          eq(reservations.propertyId, propertyId),
          sql`upper(${reservations.code}) = upper(${code})`,
        ),
      )
      .limit(1);

    const found = rows[0];
    return found ? this.findById(tx, found.id) : null;
  }

  async updateStatus(
    tx: Executor,
    reservationId: string,
    expectedVersion: number,
    status: ReservationStatus,
    patch?: {
      cancelledAt?: Date;
      cancellationReason?: string;
      checkedInAt?: Date;
      checkedOutAt?: Date;
    },
  ): Promise<number> {
    const organizationId = requireOrganizationId();

    const result = await tx
      .update(reservations)
      .set({
        status,
        // Version bump and the guard below are what make the update optimistic:
        // a concurrent writer's update matches zero rows instead of clobbering.
        version: expectedVersion + 1,
        updatedAt: new Date(),
        ...(patch?.cancelledAt ? { cancelledAt: patch.cancelledAt } : {}),
        ...(patch?.cancellationReason ? { cancellationReason: patch.cancellationReason } : {}),
        ...(patch?.checkedInAt ? { checkedInAt: patch.checkedInAt } : {}),
        ...(patch?.checkedOutAt ? { checkedOutAt: patch.checkedOutAt } : {}),
      })
      .where(
        and(
          eq(reservations.id, reservationId),
          eq(reservations.organizationId, organizationId),
          eq(reservations.version, expectedVersion),
        ),
      );

    return result.rowCount ?? 0;
  }

  private async loadStays(
    tx: Executor,
    reservationId: string,
  ): Promise<LoadedReservation['stays']> {
    const stayRows = await tx
      .select({
        id: reservationStays.id,
        roomTypeId: reservationStays.roomTypeId,
        checkIn: reservationStays.checkIn,
        checkOut: reservationStays.checkOut,
      })
      .from(reservationStays)
      .where(eq(reservationStays.reservationId, reservationId))
      .orderBy(reservationStays.checkIn);

    if (stayRows.length === 0) return [];

    const nightRows = await tx
      .select({ stayId: reservationStayNights.stayId, date: reservationStayNights.date })
      .from(reservationStayNights)
      .where(eq(reservationStayNights.reservationId, reservationId))
      .orderBy(reservationStayNights.date);

    const nightsByStay = new Map<string, IsoDate[]>();
    for (const night of nightRows) {
      const list = nightsByStay.get(night.stayId) ?? [];
      list.push(toIsoDate(night.date));
      nightsByStay.set(night.stayId, list);
    }

    return stayRows.map((stay) => ({
      id: stay.id,
      roomTypeId: stay.roomTypeId,
      checkIn: toIsoDate(stay.checkIn),
      checkOut: toIsoDate(stay.checkOut),
      nightDates: nightsByStay.get(stay.id) ?? [],
    }));
  }
}
