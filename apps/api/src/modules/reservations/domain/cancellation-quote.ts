import type { StayPolicy } from '../../booking-engine/domain/strictest-policy';

/**
 * What cancelling this booking should give back, worked out from the terms the
 * guest was promised and the money the hotel actually holds.
 *
 * Pure arithmetic: no clock, no database. The caller supplies `now`, the
 * deadline and the folio totals, so every edge below is a unit test.
 *
 * **Quoted from what was PAID, never from the total alone.** A guest who has
 * paid a ฿300 deposit on a ฿900 booking is owed at most ฿300 back; 50% of the
 * total (฿450) would refund money the hotel never received. The refundable pool
 * is therefore `paid - refunded` (voided rows already excluded by the folio),
 * and the policy percentage is applied to the booking total then capped by it.
 *
 * A null policy (an OTA or travel-agent booking, or one made before policies
 * were frozen) quotes nothing: the terms are not ours to state, so the suggestion
 * is 0 and staff enter whatever they agreed by hand.
 */
export interface CancelQuoteInput {
  readonly policy: StayPolicy | null;
  /** Booking total in minor units. */
  readonly totalMinor: number;
  /** Folio payments, gross, voided rows excluded. */
  readonly paidMinor: number;
  /** Folio refunds already given, voided rows excluded. */
  readonly refundedMinor: number;
  /** Last instant a cancellation is in time; ignored when the policy is null. */
  readonly deadline: Date | null;
  readonly now: Date;
}

export interface CancelQuote {
  readonly policy: {
    readonly noticeHours: number;
    readonly refundPercent: number;
    readonly deadline: Date;
    readonly inTime: boolean;
  } | null;
  readonly suggestedRefundMinor: number;
}

export function computeCancelQuote(input: CancelQuoteInput): CancelQuote {
  if (input.policy === null || input.deadline === null) {
    return { policy: null, suggestedRefundMinor: 0 };
  }

  // Exactly AT the deadline is in time (matches `cancellationDeadline`).
  const inTime = input.now.getTime() <= input.deadline.getTime();
  const refundable = Math.max(0, input.paidMinor - input.refundedMinor);
  const byPolicy = Math.floor((input.totalMinor * input.policy.refundPercent) / 100);
  const suggestedRefundMinor = inTime ? Math.max(0, Math.min(refundable, byPolicy)) : 0;

  return {
    policy: {
      noticeHours: input.policy.noticeHours,
      refundPercent: input.policy.refundPercent,
      deadline: input.deadline,
      inTime,
    },
    suggestedRefundMinor,
  };
}
