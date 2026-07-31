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

/** One stay loaded in full, for changing its dates, room type or occupancy. */
export interface ModifiableStay {
  readonly id: string;
  readonly reservationId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly children: number;
  readonly guestName: string | null;
  readonly assignedRoomId: string | null;
  readonly subtotalMinor: number;
  readonly nightDates: readonly IsoDate[];
}

export interface ReservationTotals {
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly serviceChargeMinor: number;
  readonly totalMinor: number;
}

export interface ReservationRepository {
  /** Insert the aggregate: reservation, stays and materialized nights. */
  insert(tx: Executor, record: ReservationRecord): Promise<void>;

  findById(tx: Executor, reservationId: string): Promise<LoadedReservation | null>;

  findStay(tx: Executor, stayId: string): Promise<ModifiableStay | null>;

  /**
   * Overwrite one stay and its nights in place.
   *
   * The nights are deleted and rewritten rather than diffed: the new dates may
   * not overlap the old ones at all, and a partial update would leave nights
   * from a range the guest is no longer staying.
   */
  replaceStay(
    tx: Executor,
    existing: ModifiableStay,
    record: StayRecord,
    options: { readonly clearAssignment: boolean },
  ): Promise<void>;

  /**
   * Rewrite the aggregate's money, guarded by `version` like `updateStatus`.
   *
   * Returns 0 when the version no longer matches. Modifying a booking someone
   * else has just changed must fail rather than silently reprice their change.
   */
  updateTotals(
    tx: Executor,
    reservationId: string,
    expectedVersion: number,
    totals: ReservationTotals,
  ): Promise<number>;

  /**
   * Every frozen night price on the booking, for re-pricing after a change.
   *
   * The stored amounts, never the rate plan: re-quoting stays nobody touched
   * would move their price whenever someone edited a different room.
   */
  findNightAmounts(tx: Executor, reservationId: string): Promise<readonly number[]>;

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
    patch?: {
      cancelledAt?: Date;
      cancellationReason?: string;
      checkedInAt?: Date;
      checkedOutAt?: Date;
    },
  ): Promise<number>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
