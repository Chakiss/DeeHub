import { getTranslations } from 'next-intl/server';

/** What a plan promises, in the two words a guest reads before the price. */
export async function PolicyLine({
  mealPlan,
  isRefundable,
}: {
  mealPlan: string;
  isRefundable: boolean;
}) {
  const t = await getTranslations('rooms');
  const meal = (
    {
      ROOM_ONLY: t('mealROOM_ONLY'),
      BREAKFAST: t('mealBREAKFAST'),
      HALF_BOARD: t('mealHALF_BOARD'),
      FULL_BOARD: t('mealFULL_BOARD'),
      ALL_INCLUSIVE: t('mealALL_INCLUSIVE'),
    } as Record<string, string>
  )[mealPlan];
  return (
    <p className="flex flex-wrap gap-x-3 text-sm text-ink-700">
      <span>{meal ?? mealPlan}</span>
      <span className={isRefundable ? 'text-success-700' : 'text-stone-500'}>
        {isRefundable ? t('refundable') : t('nonRefundable')}
      </span>
    </p>
  );
}
