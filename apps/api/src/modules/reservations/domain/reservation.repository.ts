import type { IsoDate } from '@deehub/shared';
import type { Executor } from '../../../database/executor';
import type { ReservationStatus } from './reservation-status';

export type ReservationSource = 'DIRECT' | 'OTA' | 'WALK_IN' | 'PHONE' | 'EMAIL';

export interface StayNightRecord {
  readonly date: IsoDate;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface StayRecord {
  readonly id: string;
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly children: number;
  readonly guestName: string | null;
  readonly subtotalMinor: number;
  readonly nights: readonly StayNightRecord[];
}

export interface ReservationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly code: string;
  readonly status: ReservationStatus;
  readonly source: ReservationSource;
  readonly channelId: string | null;
  readonly guestId: string | null;
  readonly bookerName: string;
  readonly bookerEmail: string | null;
  readonly bookerPhone: string | null;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly serviceChargeMinor: number;
  readonly totalMinor: number;
  readonly holdExpiresAt: Date | null;
  readonly specialRequests: string | null;
  readonly stays: readonly StayRecord[];
}

/** A reservation loaded for modification, with the nights it holds. */
export interface LoadedReservation {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly code: string;
  readonly status: ReservationStatus;
  readonly version: number;
  readonly currency: string;
  readonly totalMinor: number;
  readonly stays: readonly {
    readonly id: string;
    readonly roomTypeId: string;
    readonly checkIn: IsoDate;
    readonly checkOut: IsoDate;
    readonly nightDates: readonly IsoDate[];
  }[];
}

export interface ReservationRepository {
  /** Insert the aggregate: reservation, stays and materialized nights. */
  insert(tx: Executor, record: ReservationRecord): Promise<void>;

  findById(tx: Executor, reservationId: string): Promise<LoadedReservation | null>;

  findByCode(tx: Executor, propertyId: string, code: string): Promise<LoadedReservation | null>;

  /**
   * Status change guarded by `version` (optimistic locking).
   *
   * Returns 0 when the version no longer matches, which means someone else
   * changed the reservation first — two front-desk staff must not silently
   * overwrite each other.
   */
  updateStatus(
    tx: Executor,
    reservationId: string,
    expectedVersion: number,
    status: ReservationStatus,
    patch?: { cancelledAt?: Date; cancellationReason?: string },
  ): Promise<number>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
