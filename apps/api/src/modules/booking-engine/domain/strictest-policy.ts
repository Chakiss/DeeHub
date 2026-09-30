export interface StayPolicy {
  readonly noticeHours: number;
  readonly refundPercent: number;
}

/**
 * The one policy that is true of every stay in a booking.
 *
 * A booking can hold several stays on different rate plans, each with its own
 * frozen terms. What the guest is told (and what a single cancel would honour)
 * must be a promise we keep for ALL of them: the lowest refund wins, and on a
 * tie the longest notice, so the result is always one stay's real policy and
 * never a blend no stay has.
 *
 * A stay with no recorded policy (null: an OTA booking, or one made before
 * policies were frozen) makes the whole answer null. We cannot promise
 * anything about a booking part of which we never stated terms for.
 */
export function strictestPolicy(stays: readonly (StayPolicy | null)[]): StayPolicy | null {
  let strictest: StayPolicy | null = null;
  for (const stay of stays) {
    if (stay === null) return null;
    if (
      strictest === null ||
      stay.refundPercent < strictest.refundPercent ||
      (stay.refundPercent === strictest.refundPercent && stay.noticeHours > strictest.noticeHours)
    ) {
      strictest = { noticeHours: stay.noticeHours, refundPercent: stay.refundPercent };
    }
  }
  return strictest;
}

/** Nullable column pair → policy or null. */
export function policyOf(row: {
  readonly cancellationNoticeHours: number | null;
  readonly cancellationRefundPercent: number | null;
}): StayPolicy | null {
  return row.cancellationNoticeHours === null || row.cancellationRefundPercent === null
    ? null
    : { noticeHours: row.cancellationNoticeHours, refundPercent: row.cancellationRefundPercent };
}
