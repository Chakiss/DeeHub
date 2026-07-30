import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/dates';
import { ReservationFilters } from '@/components/reservation-filters';

const STATUS_TONE: Record<string, string> = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-200',
  CHECKED_IN: 'bg-sky-50 text-sky-700 ring-sky-200',
  CHECKED_OUT: 'bg-slate-100 text-slate-600 ring-slate-200',
  CANCELLED: 'bg-rose-50 text-rose-700 ring-rose-200',
  NO_SHOW: 'bg-rose-50 text-rose-700 ring-rose-200',
  EXPIRED: 'bg-slate-100 text-slate-500 ring-slate-200',
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

  const list = await api.reservations(propertyId, {
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      <ReservationFilters
        searchPlaceholder={t('search')}
        allStatusesLabel={t('allStatuses')}
        defaultQuery={q ?? ''}
        defaultStatus={status ?? ''}
      />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
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
                <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                  {t('empty')}
                </td>
              </tr>
            )}
            {list.items.map((reservation) => (
              <tr key={reservation.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2.5">
                  <span className="tabular font-medium text-slate-900">{reservation.code}</span>
                </td>
                <td className="px-4 py-2.5 text-slate-700">{reservation.bookerName}</td>
                <td className="tabular px-4 py-2.5 text-slate-600">
                  {reservation.checkIn && reservation.checkOut
                    ? `${reservation.checkIn} → ${reservation.checkOut}`
                    : '—'}
                </td>
                <td className="tabular px-4 py-2.5 text-right text-slate-600">
                  {reservation.rooms}
                </td>
                <td className="tabular px-4 py-2.5 text-right text-slate-600">
                  {reservation.nights}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      STATUS_TONE[reservation.status] ??
                      'bg-slate-100 text-slate-600 ring-slate-200'
                    }`}
                  >
                    {reservation.status.replace('_', ' ').toLowerCase()}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-slate-400">
                  {reservation.source}
                </td>
                <td className="tabular px-4 py-2.5 text-right font-medium text-slate-800">
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
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
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
