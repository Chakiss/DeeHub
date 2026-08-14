import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/dates';
import { ReservationFilters } from '@/components/reservation-filters';

const STATUS_TONE: Record<string, string> = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-200',
  CHECKED_IN: 'bg-sky-50 text-sky-700 ring-sky-200',
  CHECKED_OUT: 'bg-sunk text-stone-600 ring-stone-200',
  CANCELLED: 'bg-rose-50 text-rose-700 ring-rose-200',
  NO_SHOW: 'bg-rose-50 text-rose-700 ring-rose-200',
  EXPIRED: 'bg-sunk text-stone-500 ring-stone-200',
};

export default async function ReservationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ q?: string; status?: string; cursor?: string }>;
}) {
  const { propertyId } = await params;
  const { q, status, cursor } = await searchParams;
  const t = await getTranslations('reservations');

  const [list, me] = await Promise.all([
    api.reservations(propertyId, {
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    api.me(),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
          <p className="text-sm text-stone-500">{t('subtitle')}</p>
        </div>
        {me.capabilities.includes('reservation:create') && (
          <Link
            href={`/properties/${propertyId}/reservations/new`}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('newBooking')}
          </Link>
        )}
      </div>

      <ReservationFilters
        searchPlaceholder={t('search')}
        allStatusesLabel={t('allStatuses')}
        defaultQuery={q ?? ''}
        defaultStatus={status ?? ''}
      />

      <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
              <Th>{t('code')}</Th>
              <Th>{t('guest')}</Th>
              <Th>{t('stay')}</Th>
              <Th className="text-right">{t('rooms')}</Th>
              <Th className="text-right">{t('nights')}</Th>
              <Th>{t('status')}</Th>
              <Th>{t('source')}</Th>
              <Th className="text-right">{t('total')}</Th>
            </tr>
          </thead>
          <tbody>
            {list.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-stone-500">
                  {t('empty')}
                </td>
              </tr>
            )}
            {list.items.map((reservation) => (
              <tr key={reservation.id} className="border-b border-stone-100 hover:bg-sunk/70">
                <td className="px-4 py-2.5">
                  <Link
                    href={`/properties/${propertyId}/reservations/${reservation.id}`}
                    className="tabular font-medium text-ink-900 underline-offset-2 hover:underline"
                  >
                    {reservation.code}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-ink-700">{reservation.bookerName}</td>
                <td className="tabular px-4 py-2.5 text-stone-600">
                  {reservation.checkIn && reservation.checkOut
                    ? `${reservation.checkIn} → ${reservation.checkOut}`
                    : '—'}
                </td>
                <td className="tabular px-4 py-2.5 text-right text-stone-600">
                  {reservation.rooms}
                </td>
                <td className="tabular px-4 py-2.5 text-right text-stone-600">
                  {reservation.nights}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      STATUS_TONE[reservation.status] ?? 'bg-sunk text-stone-600 ring-stone-200'
                    }`}
                  >
                    {reservation.status.replace('_', ' ').toLowerCase()}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-stone-400">
                  {reservation.source}
                </td>
                <td className="tabular px-4 py-2.5 text-right font-medium text-ink-800">
                  {formatMoney(reservation.total.amount, reservation.total.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {list.pageInfo.hasMore && list.pageInfo.nextCursor && (
        <div className="flex justify-center">
          <Link
            href={buildHref(propertyId, { q, status, cursor: list.pageInfo.nextCursor })}
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('loadMore')}
          </Link>
        </div>
      )}
    </div>
  );
}

function buildHref(
  propertyId: string,
  params: { q?: string; status?: string; cursor?: string },
): string {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.status) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  return `/properties/${propertyId}/reservations?${query.toString()}`;
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>;
}
