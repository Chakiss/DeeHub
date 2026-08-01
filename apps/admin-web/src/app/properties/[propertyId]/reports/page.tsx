import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { PerformanceReport } from '@/components/performance-report';
import { PickupReport } from '@/components/pickup-report';
import { addDays, businessDate } from '@/lib/dates';

/**
 * Looks BACK by default, not forward.
 *
 * The inventory grid answers "what can I still sell"; this answers "how did we
 * do". Opening it on the future would show an empty table every morning.
 */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Pickup looks the other way: forward over the stay dates still to come,
 * backward only for the baseline it measures against.
 *
 * Sixty nights ahead covers the booking window a small hotel actually manages;
 * a baseline of seven days is the question somebody asks on a Monday.
 */
const PICKUP_HORIZON_DAYS = 60;
const PICKUP_BASELINE_DAYS = 7;

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ from?: string; days?: string }>;
}) {
  const { propertyId } = await params;
  const { from: fromParam, days } = await searchParams;
  const t = await getTranslations('reports');

  const properties = await api.properties();
  const property = properties.find((candidate) => candidate.id === propertyId);
  // Today in the property's timezone, never the server's.
  const today = businessDate(property?.timezone ?? 'Asia/Bangkok');

  const window = days === '7' ? 7 : DEFAULT_WINDOW_DAYS;
  // `to` is exclusive and today's night is not over, so the range ends today.
  const from = fromParam ?? addDays(today, -window);
  const to = addDays(from, window);

  const [performance, pickup] = await Promise.all([
    api.performance(propertyId, from, to),
    api.pickup(
      propertyId,
      today,
      addDays(today, PICKUP_HORIZON_DAYS),
      addDays(today, -PICKUP_BASELINE_DAYS),
    ),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
          <p className="text-sm text-slate-500">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <RangeLink days={7} active={window === 7} label={t('last7')} />
          <RangeLink days={30} active={window === 30} label={t('last30')} />
        </div>
      </div>

      <PerformanceReport propertyId={propertyId} performance={performance} />

      <div className="pt-2">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">{t('pickupTitle')}</h2>
        <p className="mb-3 text-sm text-slate-500">{t('pickupSubtitle')}</p>
        <PickupReport pickup={pickup} />
      </div>
    </div>
  );
}

function RangeLink({ days, active, label }: { days: number; active: boolean; label: string }) {
  return (
    <Link
      href={`?days=${String(days)}`}
      aria-current={active ? 'true' : undefined}
      className={`rounded-md border px-3 py-1.5 text-sm transition ${
        active
          ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {label}
    </Link>
  );
}
