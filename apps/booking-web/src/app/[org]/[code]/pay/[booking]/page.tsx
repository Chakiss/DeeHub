import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { loadHotel } from '@/lib/hotel';
import type { Locale } from '@/i18n/locale';
import { PaymentPanel } from '@/components/payment-panel';
import { Shell } from '@/components/shell';

type Params = Promise<{ org: string; code: string; booking: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { robots: { index: false } };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Pay for a held booking. A booking that is no longer PENDING has nothing
 * to pay and goes straight to its confirmation page; a hotel with no
 * provider gets a calm note rather than a broken checkout.
 */
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const [{ org, code, booking: bookingCode }, query] = await Promise.all([params, searchParams]);
  const email = first(query['email']) ?? '';
  if (!email) notFound();

  const [hotel, t, tc, locale] = await Promise.all([
    loadHotel(org, code),
    getTranslations('pay'),
    getTranslations('common'),
    getLocale() as Promise<Locale>,
  ]);

  let booking;
  try {
    booking = await api.booking(org, code, bookingCode, email);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const confirmation = `/${org}/${code}/bookings/${bookingCode}?email=${encodeURIComponent(email)}`;
  if (booking.status !== 'PENDING') redirect(confirmation);

  const holdUntil = booking.holdExpiresAt
    ? new Date(booking.holdExpiresAt).toLocaleTimeString(locale === 'th' ? 'th-TH' : 'en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: hotel.timezone,
      })
    : null;
  const pendingIntent = booking.payment?.status === 'PENDING' ? booking.payment.intentId : null;

  return (
    <Shell org={org} code={code} hotelName={hotel.name}>
      <div className="mx-auto max-w-lg space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-ink-700">{t('bookingCode', { code: booking.code })}</p>
          {holdUntil && (
            <p className="text-sm text-accent-500">{t('holdUntil', { time: holdUntil })}</p>
          )}
        </div>

        <div className="rounded-2xl border border-stone-200/70 bg-raised p-4 text-sm shadow-card">
          {booking.stays.map((stay, index) => (
            <p key={index}>
              {stay.roomTypeName} · {tc('adults', { count: stay.adults })}
            </p>
          ))}
          <p className="text-ink-700">
            {formatDate(booking.checkIn, locale)} → {formatDate(booking.checkOut, locale)}
          </p>
          <p className="mt-2 flex justify-between text-base font-semibold">
            <span>{tc('total')}</span>
            <span className="tabular">{formatMoney(booking.total, booking.currency, locale)}</span>
          </p>
        </div>

        {hotel.paymentAvailable ? (
          <div className="rounded-2xl border border-stone-200/70 bg-raised p-5 shadow-card">
            <PaymentPanel
              org={org}
              code={code}
              bookingCode={booking.code}
              email={email}
              amountMinor={booking.total}
              currency={booking.currency}
              methods={hotel.paymentMethods}
              omisePublicKey={process.env.OMISE_PUBLIC_KEY ?? null}
              initialIntent={pendingIntent}
            />
          </div>
        ) : (
          <div className="rounded-2xl bg-success-50 p-5 text-sm text-success-700">
            <p className="font-medium">{t('noOnline')}</p>
            <p className="mt-1">{t('noOnlineBody', { email })}</p>
            <a href={confirmation} className="mt-3 inline-block font-medium underline">
              {t('back')}
            </a>
          </div>
        )}
      </div>
    </Shell>
  );
}
