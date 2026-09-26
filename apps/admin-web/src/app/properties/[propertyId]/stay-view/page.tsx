import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { StayViewGrid } from '@/components/stay-view-grid';
import { addDays, businessDate } from '@/lib/dates';

/** A fortnight: the horizon a front desk actually plans over. */
const DEFAULT_WINDOW_DAYS = 14;

export default async function StayViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { propertyId } = await params;
  const { from: fromParam } = await searchParams;
  const t = await getTranslations('stayView');

  // The property's own timezone, never the server's: a Bangkok hotel viewed
  // from us-central1 must not open on yesterday.
  const properties = await api.properties();
  const property = properties.find((candidate) => candidate.id === propertyId);
  const today = businessDate(property?.timezone ?? 'Asia/Bangkok');
  // Open on YESTERDAY: the desk's first question in the morning is who slept
  // here last night and whether they have left yet, and a window that starts
  // today cannot answer it.
  const from = fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : addDays(today, -1);
  const to = addDays(from, DEFAULT_WINDOW_DAYS);

  const [view, me] = await Promise.all([api.stayView(propertyId, from, to), api.me()]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      <StayViewGrid
        propertyId={propertyId}
        view={view}
        from={from}
        today={today}
        canAssign={me.capabilities.includes('reservation:update')}
      />
    </div>
  );
}
