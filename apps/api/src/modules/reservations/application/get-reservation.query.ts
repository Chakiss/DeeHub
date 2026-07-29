import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../../../database/database.module';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';

export interface ReservationView {
  readonly id: string;
  readonly code: string;
  readonly propertyId: string;
  readonly status: string;
  readonly version: number;
  readonly currency: string;
  readonly total: { amount: number; currency: string };
  readonly stays: readonly {
    readonly id: string;
    readonly roomTypeId: string;
    readonly checkIn: string;
    readonly checkOut: string;
    readonly nights: readonly string[];
  }[];
}

/**
 * Read model for a single reservation.
 *
 * Separate from the write use cases: reads need no transaction, no locking and
 * no events, and mixing them would invite a query into the booking path.
 */
@Injectable()
export class GetReservationQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
  ) {}

  async byId(reservationId: string): Promise<ReservationView | null> {
    const reservation = await this.reservations.findById(this.db, reservationId);
    if (!reservation) return null;

    return {
      id: reservation.id,
      code: reservation.code,
      propertyId: reservation.propertyId,
      status: reservation.status,
      // The client echoes this back when mutating, for optimistic locking.
      version: reservation.version,
      currency: reservation.currency,
      total: { amount: reservation.totalMinor, currency: reservation.currency },
      stays: reservation.stays.map((stay) => ({
        id: stay.id,
        roomTypeId: stay.roomTypeId,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        nights: [...stay.nightDates],
      })),
    };
  }
}
