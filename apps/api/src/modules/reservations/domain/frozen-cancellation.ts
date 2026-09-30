import type { ReservationSource } from './reservation.repository';

/** A rate plan's cancellation terms as `PlanStayService` reports them. */
export interface PlanCancellation {
  readonly noticeHours: number;
  readonly refundPercent: number;
}

/**
 * What to freeze onto a stay for a booking of this source.
 *
 * The single place that maps "plan + source" to stored columns, used by both
 * booking and plan-change-on-modify. OTA and travel-agent bookings were sold
 * under terms that are not ours to state, so they record nothing. Everyone else
 * gets the plan's terms (`PlanStayService` already turns a non-refundable plan
 * into an explicit 0 / 0).
 */
export function frozenCancellation(
  source: ReservationSource,
  plan: PlanCancellation,
): { cancellationNoticeHours: number | null; cancellationRefundPercent: number | null } {
  if (source === 'OTA' || source === 'TRAVEL_AGENT') {
    return { cancellationNoticeHours: null, cancellationRefundPercent: null };
  }
  return {
    cancellationNoticeHours: plan.noticeHours,
    cancellationRefundPercent: plan.refundPercent,
  };
}
