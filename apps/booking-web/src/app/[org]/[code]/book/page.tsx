import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { formatDate, formatMoney, nightsBetween } from '@/lib/format';
import { loadHotel } from '@/lib/hotel';
import { parseStay } from '@/lib/stay-query';
import type { Locale } from '@/i18n/locale';
import { BookingForm } from '@/components/booking-form';
import { PolicyLine } from '@/components/policy-line';
import { Shell } from '@/components/shell';

type Params = Promise<{ org: string; code: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { robots: { index: false } };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The one screen with the final figure on it, so it carries the microdata
 * Google's price-accuracy crawler reads (`data-nav-stage-final`): hotel,
 * dates, guests, and one total in one currency. The price is re-read from
 * the API here rather than carried in the URL — a URL can be edited.
 */
export default async function BookPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const [{ org, code }, query] = await Promise.all([params, searchParams]);
  const stay = parseStay(query);
  const roomTypeId = first(query['roomTypeId']);
  const ratePlanId = first(query['ratePlanId']);
  if (!roomTypeId || !ratePlanId) notFound();

  const [hotel, t, tc, locale] = await Promise.all([
    loadHotel(org, code),
    getTranslations('book'),
    getTranslations('common'),
    getLocale() as Promise<Locale>,
  ]);
  const availability = await api.availability(org, code, stay);
  const room = availability.roomTypes.find((candidate) => candidate.roomTypeId === roomTypeId);
  const plan = room?.ratePlans.find((candidate) => candidate.ratePlanId === ratePlanId);
  if (!room || !plan) notFound();
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const currency = availability.currency;

  return (
    <Shell org={org} code={code} hotelName={hotel.name}>
      <div
        className="grid gap-6 lg:grid-cols-[1fr_360px]"
        itemScope
        itemType="https://schema.org/LodgingReservation"
        data-nav-stage-final="true"
      >
        <section className="space-y-4 rounded-2xl border border-stone-200/70 bg-raised p-5 shadow-card">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <BookingForm
            hidden={{
              org,
              code,
              checkIn: stay.checkIn,
              checkOut: stay.checkOut,
              adults: String(stay.adults),
              children: String(stay.children),
              roomTypeId,
              ratePlanId,
            }}
          />
        </section>

        <aside className="space-y-3 rounded-2xl border border-stone-200/70 bg-raised p-5 shadow-card lg:sticky lg:top-4 lg:self-start">
          <h2 className="text-lg font-semibold">{t('summary')}</h2>
          <meta itemProp="name" content={hotel.name} />
          <p
            className="font-medium"
            itemProp="reservationFor"
            itemScope
            itemType="https://schema.org/HotelRoom"
          >
            <span itemProp="name">{room.name}</span> · {plan.name}
          </p>
          <PolicyLine mealPlan={plan.mealPlan} isRefundable={plan.isRefundable} />
          <p className="text-sm text-ink-700">
            <span itemProp="checkinTime" content={stay.checkIn}>
              {formatDate(stay.checkIn, locale)}
            </span>{' '}
            →{' '}
            <span itemProp="checkoutTime" content={stay.checkOut}>
              {formatDate(stay.checkOut, locale)}
            </span>
            <br />
            {tc('night', { count: nights })} · <span itemProp="numAdults">{stay.adults}</span>{' '}
            {tc('adults', { count: stay.adults }).replace(String(stay.adults), '').trim()}
            {stay.children > 0 && (
              <>
                {' '}
                · <span itemProp="numChildren">{stay.children}</span>{' '}
                {tc('children', { count: stay.children }).replace(String(stay.children), '').trim()}
              </>
            )}
          </p>
          <dl className="space-y-1 border-t border-stone-200/70 pt-3 text-sm">
            <div className="flex justify-between">
              <dt>{t('subtotal')}</dt>
              <dd className="tabular">{formatMoney(plan.breakdown.subtotal, currency, locale)}</dd>
            </div>
            {plan.breakdown.serviceCharge > 0 && (
              <div className="flex justify-between">
                <dt>{t('serviceCharge')}</dt>
                <dd className="tabular">
                  {formatMoney(plan.breakdown.serviceCharge, currency, locale)}
                </dd>
              </div>
            )}
            {plan.breakdown.tax > 0 && (
              <div className="flex justify-between">
                <dt>{t('tax')}</dt>
                <dd className="tabular">{formatMoney(plan.breakdown.tax, currency, locale)}</dd>
              </div>
            )}
            <div
              className="flex justify-between border-t border-stone-200/70 pt-2 text-base font-semibold"
              itemProp="totalPrice"
              itemScope
              itemType="https://schema.org/CompoundPriceSpecification"
            >
              <dt>{tc('total')}</dt>
              <dd className="tabular">
                <span itemProp="price" content={(plan.breakdown.total / 100).toFixed(2)}>
                  {formatMoney(plan.breakdown.total, currency, locale)}
                </span>
                <meta itemProp="priceCurrency" content={currency} />
              </dd>
            </div>
          </dl>
          <p className="text-xs text-stone-500">{tc('totalIncludes', { nights })}</p>
        </aside>
      </div>
    </Shell>
  );
}
