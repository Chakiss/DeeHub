import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { api, ApiError, type Booking } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { loadHotel } from '@/lib/hotel';
import type { Locale } from '@/i18n/locale';
import { Shell } from '@/components/shell';

type Params = Promise<{ org: string; code: string; booking: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { robots: { index: false } };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The booking, to the person who made it. Without the email — the second
 * factor — the page asks for it instead of guessing; with the wrong one it
 * says nothing about whether the code exists.
 */
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const [{ org, code, booking: bookingCode }, query] = await Promise.all([params, searchParams]);
  const email = first(query['email']) ?? '';
  const [hotel, t, tc, locale] = await Promise.all([
    loadHotel(org, code),
    getTranslations('confirm'),
    getTranslations('common'),
    getLocale() as Promise<Locale>,
  ]);

  let booking: Booking | null = null;
  let failed = false;
  if (email) {
    try {
      booking = await api.booking(org, code, bookingCode, email);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 422))
        failed = true;
      else throw error;
    }
  }

  if (!booking) {
    return (
      <Shell org={org} code={code} hotelName={hotel.name}>
        <form
          method="get"
          className="mx-auto max-w-sm space-y-3 rounded-2xl border border-stone-200/70 bg-raised p-5 shadow-card"
        >
          <h1 className="text-xl font-semibold">{t('lookup')}</h1>
          <p className="text-sm text-ink-700">
            {t('lookupCode')}: <span className="font-mono">{bookingCode}</span>
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">{t('lookupEmail')}</span>
            <input
              name="email"
              type="email"
              required
              defaultValue={email}
              className="w-full rounded-lg border border-stone-300 px-3 py-2.5 text-base"
            />
          </label>
          {failed && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {t('lookupFailed')}
            </p>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 px-5 py-3 font-medium text-white"
          >
            {t('lookupGo')}
          </button>
        </form>
      </Shell>
    );
  }

  const paid = booking.payment?.status === 'PAID';
  const title =
    booking.status === 'CANCELLED' || booking.status === 'EXPIRED'
      ? t('titleCancelled')
      : booking.status === 'PENDING'
        ? t('titlePending')
        : t('title');

  return (
    <Shell org={org} code={code} hotelName={hotel.name}>
      <div className="mx-auto max-w-lg space-y-5">
        <div
          className={`rounded-2xl p-5 ${booking.status === 'CANCELLED' || booking.status === 'EXPIRED' ? 'bg-sunk' : 'bg-success-50'}`}
        >
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-ink-700">{t('code')}</p>
          <p className="font-mono text-2xl font-semibold tracking-wider">{booking.code}</p>
          <p className="mt-2 text-sm text-ink-700">
            {booking.status === 'PENDING'
              ? t('pendingBody')
              : booking.status === 'CANCELLED' || booking.status === 'EXPIRED'
                ? t('cancelledBody')
                : t('emailSent', { email })}
          </p>
        </div>

        <dl className="space-y-2 rounded-2xl border border-stone-200/70 bg-raised p-5 text-sm shadow-card">
          <div className="flex justify-between">
            <dt className="text-ink-700">{t('stay')}</dt>
            <dd>
              {formatDate(booking.checkIn, locale)} → {formatDate(booking.checkOut, locale)}
            </dd>
          </div>
          {booking.stays.map((stay, index) => (
            <div key={index} className="flex justify-between">
              <dt className="text-ink-700">{stay.roomTypeName}</dt>
              <dd>
                {tc('adults', { count: stay.adults })}
                {stay.children > 0 ? ` · ${tc('children', { count: stay.children })}` : ''}
              </dd>
            </div>
          ))}
          <div className="flex justify-between border-t border-stone-200/70 pt-2 text-base font-semibold">
            <dt>{tc('total')}</dt>
            <dd className="tabular">{formatMoney(booking.total, booking.currency, locale)}</dd>
          </div>
          <div className="flex justify-between text-xs text-stone-500">
            <dt>{paid ? t('paid') : t('due')}</dt>
            <dd>{booking.bookerName}</dd>
          </div>
        </dl>
      </div>
    </Shell>
  );
}
