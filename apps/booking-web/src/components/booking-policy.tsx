import { getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/lib/format';
import type { Locale } from '@/i18n/locale';

/**
 * The cancellation terms a booking was made under, from the values frozen on
 * it. Nothing at all when none were recorded. Once the deadline has passed the
 * booking is simply non-refundable, and the line says that instead.
 */
export async function BookingPolicy({
  cancellation,
  locale,
  timeZone,
}: {
  cancellation: { noticeHours: number; refundPercent: number; deadline: string } | null;
  locale: Locale;
  timeZone: string;
}) {
  if (!cancellation) return null;
  const t = await getTranslations('cancellation');
  const passed = Date.parse(cancellation.deadline) < Date.now();
  const nonRefundable = passed || cancellation.refundPercent === 0;

  return (
    <p className="mt-2 text-sm text-ink-700" data-testid="booking-cancellation">
      {nonRefundable
        ? t('bookingNonRefundable')
        : t('bookingDeadline', {
            date: formatDateTime(cancellation.deadline, locale, timeZone),
            percent: cancellation.refundPercent,
          })}
    </p>
  );
}
