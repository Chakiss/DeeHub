import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { formatDate, formatMoney, nightsBetween } from '@/lib/format';
import { loadHotel, roomDescription } from '@/lib/hotel';
import { parseStay, stayToSearch } from '@/lib/stay-query';
import type { Locale } from '@/i18n/locale';
import { PolicyLine } from '@/components/policy-line';
import { Shell } from '@/components/shell';
import { StayForm } from '@/components/stay-form';

type Params = Promise<{ org: string; code: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { org, code } = await params;
  const hotel = await loadHotel(org, code);
  return { title: `${hotel.name} — rooms`, robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * What can be booked for these dates, every price all-in.
 *
 * When the visitor arrived from Google with a rate or room named, that
 * offer is lifted to the top and marked — Google's crawler and a human both
 * expect to find the price they clicked without scrolling for it. The
 * microdata on each offer is what the crawler reads to check that the price
 * shown here is the price it showed.
 */
export default async function RoomsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const [{ org, code }, query] = await Promise.all([params, searchParams]);
  const stay = parseStay(query);
  const wantedRate = first(query['rate']);
  const wantedRoom = first(query['room']);
  const [hotel, t, tc, locale] = await Promise.all([
    loadHotel(org, code),
    getTranslations('rooms'),
    getTranslations('common'),
    getLocale() as Promise<Locale>,
  ]);
  const availability = await api.availability(org, code, stay);
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const catalogRoom = new Map(hotel.roomTypes.map((room) => [room.roomTypeId, room]));

  const roomTypes = [...availability.roomTypes].sort((a, b) => {
    const score = (room: typeof a) =>
      (room.roomTypeId === wantedRoom ? 2 : 0) +
      (room.ratePlans.some((plan) => plan.ratePlanId === wantedRate) ? 1 : 0);
    return score(b) - score(a);
  });

  return (
    <Shell org={org} code={code} hotelName={hotel.name}>
      <div className="space-y-6" data-nav-stage="rooms">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-ink-700">
            {t('stay', {
              checkIn: formatDate(stay.checkIn, locale),
              checkOut: formatDate(stay.checkOut, locale),
            })}{' '}
            · {tc('night', { count: nights })} · {tc('adults', { count: stay.adults })}
            {stay.children > 0 ? ` · ${tc('children', { count: stay.children })}` : ''}
          </p>
        </div>

        <details className="rounded-2xl border border-stone-200/70 bg-raised shadow-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-brand-600">
            {t('change')}
          </summary>
          <div className="px-4 pb-4">
            <StayForm org={org} code={code} stay={stay} min={stay.checkIn} />
          </div>
        </details>

        {roomTypes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-raised px-6 py-10 text-center">
            <p className="font-medium">{t('none')}</p>
            <p className="text-sm text-stone-500">{t('noneHint')}</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {roomTypes.map((room) => {
              const details = catalogRoom.get(room.roomTypeId);
              const photo = details?.photos[0];
              return (
                <li
                  key={room.roomTypeId}
                  className="overflow-hidden rounded-2xl border border-stone-200/70 bg-raised shadow-card sm:grid sm:grid-cols-[240px_1fr]"
                >
                  {photo ? (
                    <img
                      src={photo.url}
                      alt={photo.alt ?? room.name}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover sm:h-full"
                    />
                  ) : (
                    <div className="hidden bg-sunk sm:block" />
                  )}
                  <div className="space-y-3 p-4">
                    <div>
                      <h2 className="text-lg font-semibold">{room.name}</h2>
                      {details && (
                        <p className="text-sm text-ink-700">
                          {[
                            details.bedConfig,
                            details.sizeSqm ? `${String(details.sizeSqm)} m²` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                      {details && roomDescription(details, locale) && (
                        <p className="mt-1 line-clamp-2 text-sm text-stone-600">
                          {roomDescription(details, locale)}
                        </p>
                      )}
                      {room.availableUnits <= 2 && (
                        <p className="mt-1 text-xs font-medium text-accent-500">
                          {t('left', { count: room.availableUnits })}
                        </p>
                      )}
                    </div>
                    <ul className="divide-y divide-stone-200/70">
                      {room.ratePlans.map((plan) => {
                        const highlighted = plan.ratePlanId === wantedRate;
                        return (
                          <li
                            key={plan.ratePlanId}
                            itemScope
                            itemType="https://schema.org/Offer"
                            className={`flex flex-wrap items-end justify-between gap-3 py-3 ${highlighted ? 'rounded-lg bg-brand-50 px-3' : ''}`}
                          >
                            <div className="space-y-0.5">
                              {highlighted && (
                                <p className="text-xs font-medium text-brand-600">
                                  {t('highlighted')}
                                </p>
                              )}
                              <p className="font-medium" itemProp="name">
                                {plan.name}
                              </p>
                              <PolicyLine
                                mealPlan={plan.mealPlan}
                                isRefundable={plan.isRefundable}
                              />
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-stone-500">
                                {formatMoney(
                                  Math.round(plan.breakdown.total / nights),
                                  availability.currency,
                                  locale,
                                )}{' '}
                                {tc('perNight')}
                              </p>
                              <p
                                className="text-xl font-semibold tabular"
                                itemProp="priceSpecification"
                                itemScope
                                itemType="https://schema.org/CompoundPriceSpecification"
                              >
                                <span
                                  itemProp="price"
                                  content={(plan.breakdown.total / 100).toFixed(2)}
                                >
                                  {formatMoney(plan.breakdown.total, availability.currency, locale)}
                                </span>
                                <meta itemProp="priceCurrency" content={availability.currency} />
                              </p>
                              <p className="text-xs text-stone-500">
                                {tc('totalIncludes', { nights })}
                              </p>
                              <Link
                                href={`/${org}/${code}/book?${stayToSearch(stay, { roomTypeId: room.roomTypeId, ratePlanId: plan.ratePlanId })}`}
                                className="mt-2 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                              >
                                {t('book')}
                              </Link>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Shell>
  );
}
