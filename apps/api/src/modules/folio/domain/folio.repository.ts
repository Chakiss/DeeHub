import type { IsoDate } from '@deehub/shared';
import type { Executor } from '../../../database/executor';
import type {
  ExtraChargeLine,
  FolioChargeKind,
  FolioPaymentKind,
  FolioPaymentMethod,
  PaymentLine,
  RoomChargeLine,
} from './folio';

export interface FolioSubject {
  readonly reservationId: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly code: string;
  readonly status: string;
  readonly bookerName: string;
  readonly currency: string;
}

export interface NewCharge {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly kind: FolioChargeKind;
  readonly description: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly taxable: boolean;
  readonly businessDate: IsoDate;
  readonly postedByUserId: string | null;
}

export interface NewPayment {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly kind: FolioPaymentKind;
  readonly method: FolioPaymentMethod;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reference: string | null;
  readonly businessDate: IsoDate;
  readonly recordedByUserId: string | null;
}

/**
 * Folio persistence.
 *
 * Room charges are READ from the reservation rather than stored, so there is no
 * write method for them — see the note on the schema. Everything here is either
 * an extra charge or money that moved.
 */
export interface FolioRepository {
  findSubject(tx: Executor, reservationId: string): Promise<FolioSubject | null>;

  /**
   * The stay's frozen night prices, as folio lines.
   *
   * Read from `reservation_stay_nights`, which is what the guest was quoted and
   * what every other total in the system is built from. A cancelled booking
   * returns its nights too: the account still has to say what was charged.
   */
  findRoomCharges(tx: Executor, reservationId: string): Promise<readonly RoomChargeLine[]>;

  findExtraCharges(tx: Executor, reservationId: string): Promise<readonly ExtraChargeLine[]>;
  findPayments(tx: Executor, reservationId: string): Promise<readonly PaymentLine[]>;

  insertCharge(tx: Executor, charge: NewCharge): Promise<void>;
  insertPayment(tx: Executor, payment: NewPayment): Promise<void>;

  /**
   * Void a line. Returns false when it is already void or does not exist.
   *
   * Conditional on `voided_at IS NULL` in the WHERE, not read-then-write: two
   * clerks clicking void on the same mis-keyed payment must not each record a
   * reversal.
   */
  voidCharge(
    tx: Executor,
    chargeId: string,
    reservationId: string,
    by: { userId: string | null; reason: string; at: Date },
  ): Promise<boolean>;

  voidPayment(
    tx: Executor,
    paymentId: string,
    reservationId: string,
    by: { userId: string | null; reason: string; at: Date },
  ): Promise<boolean>;
}

export const FOLIO_REPOSITORY = Symbol('FOLIO_REPOSITORY');
