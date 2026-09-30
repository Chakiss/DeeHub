import { getTranslations } from 'next-intl/server';

export interface PolicyCancellation {
  noticeHours: number;
  refundPercent: number;
  /** ISO instant; when past, nothing is refundable and the line says so. */
  deadline?: string;
}

/**
 * What a plan promises, in the two facts a guest reads before the price: the
 * meal, and what cancelling costs.
 *
 * A booking made after the deadline has already passed (tonight's room) says
 * "No refund once booked" plainly. The comparison is on the server, so there is
 * no client script and no flash of the wrong promise.
 */
export async function PolicyLine({
  mealPlan,
  cancellation,
  isRefundable,
}: {
  mealPlan: string;
  /**
   * `undefined` only from an older API during a rolling deploy, before it sent
   * the field: fall back to the plain refundable flag rather than calling every
   * plan non-refundable. `null` is a real answer: not refundable.
   */
  cancellation: PolicyCancellation | null | undefined;
  isRefundable?: boolean;
}) {
  const t = await getTranslations('rooms');
  const tc = await getTranslations('cancellation');
  const meal = (
    {
      ROOM_ONLY: t('mealROOM_ONLY'),
      BREAKFAST: t('mealBREAKFAST'),
      HALF_BOARD: t('mealHALF_BOARD'),
      FULL_BOARD: t('mealFULL_BOARD'),
      ALL_INCLUSIVE: t('mealALL_INCLUSIVE'),
    } as Record<string, string>
  )[mealPlan];

  let text: string;
  let refundable = true;
  if (cancellation === undefined) {
    refundable = isRefundable ?? false;
    text = refundable ? tc('legacyRefundable') : t('nonRefundable');
  } else if (!cancellation || cancellation.refundPercent === 0) {
    text = t('nonRefundable');
    refundable = false;
  } else if (cancellation.deadline && Date.parse(cancellation.deadline) < Date.now()) {
    text = tc('noRefundOnceBooked');
    refundable = false;
  } else if (cancellation.refundPercent === 100) {
    text =
      cancellation.noticeHours === 0
        ? tc('freeUntilCheckIn')
        : tc('freeUntil', { hours: cancellation.noticeHours });
  } else {
    text = tc('partial', {
      hours: cancellation.noticeHours,
      percent: cancellation.refundPercent,
    });
  }

  return (
    <p className="flex flex-wrap gap-x-3 text-sm text-ink-700">
      <span>{meal ?? mealPlan}</span>
      <span className={refundable ? 'text-success-700' : 'text-stone-500'}>{text}</span>
    </p>
  );
}
