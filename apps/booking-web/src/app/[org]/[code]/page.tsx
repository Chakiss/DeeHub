import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { addDays, formatMoney, todayInBangkok } from '@/lib/format';
import { clock, description, loadHotel, mapsLink, roomDescription } from '@/lib/hotel';
import { parseStay, stayToSearch } from '@/lib/stay-query';
import type { Locale } from '@/i18n/locale';
import { PhotoStrip } from '@/components/photo-strip';
import { Shell } from '@/components/shell';
import { StayForm } from '@/components/stay-form';

type Params = Promise<{ org: string; code: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { org, code } = await params;
  const hotel = await loadHotel(org, code);
  return {
    title: hotel.name,
    description: hotel.descriptionEn ?? hotel.descriptionTh ?? undefined,
    openGraph: hotel.photos[0] ? { images: [hotel.photos[0].url] } : undefined,
  };
}

/**
 * The hotel, before a date is chosen. Everything on it is the hotel's own
 * words and pictures from the dashboard; the only computed thing is the
 * two-week price strip, which is the "from ฿450" Google shows, per night.
 */
export default async function HotelPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const [{ org, code }, query] = await Promise.all([params, searchParams]);
  const [hotel, t, locale] = await Promise.all([
    loadHotel(org, code),
    getTranslations('hotel'),
    getLocale() as Promise<Locale>,
  ]);
  const stay = parseStay(query);
  const today = todayInBangkok();
  const strip = await api.lowest(org, code, today, addDays(today, 14)).catch(() => null);
  const about = description(hotel, locale);
  const maps = mapsLink(hotel);

  return (
    <Shell org={org} code={code} hotelName={hotel.name}>
      <div className="space-y-8">
        <PhotoStrip photos={hotel.photos} alt={hotel.name} />

        <section className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">{hotel.name}</h1>
          <p className="text-sm text-ink-700">
            {[
              hotel.address.line1,
              hotel.address.line2,
              hotel.address.city,
              hotel.address.postalCode,
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
          <p className="rounded-lg bg-success-50 px-3 py-2 text-sm text-success-700">
            {t('officialSite')}
          </p>
        </section>

        <StayForm org={org} code={code} stay={stay} min={today} />

        {strip && strip.nights.some((night) => night.fromTotalMinor !== null) && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-ink-700">{t('nextNights')}</h2>
            <ol className="flex gap-2 overflow-x-auto pb-2">
              {strip.nights.map((night) => (
                <li key={night.date} className="shrink-0">
                  <Link
                    href={`/${org}/${code}/rooms?${stayToSearch({ ...stay, checkIn: night.date, checkOut: addDays(night.date, 1) })}`}
                    className="block w-20 rounded-xl border border-stone-200/70 bg-raised px-2 py-2 text-center text-xs shadow-card hover:border-brand-500"
                  >
                    <span className="block text-stone-500">
                      {night.date.slice(8, 10)}/{night.date.slice(5, 7)}
                    </span>
                    <span className="block font-medium tabular">
                      {night.fromTotalMinor === null
                        ? t('soldOut')
                        : formatMoney(night.fromTotalMinor, strip.currency, locale)}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        )}

        {about && (
          <section>
            <h2 className="mb-2 text-lg font-semibold">{t('about')}</h2>
            <p className="whitespace-pre-line text-ink-700">{about}</p>
          </section>
        )}

        {hotel.roomTypes.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('rooms')}</h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {hotel.roomTypes.map((room) => (
                <li
                  key={room.roomTypeId}
                  className="overflow-hidden rounded-2xl border border-stone-200/70 bg-raised shadow-card"
                >
                  {room.photos[0] && (
                    <img
                      src={room.photos[0].url}
                      alt={room.photos[0].alt ?? room.name}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover"
                    />
                  )}
                  <div className="space-y-1 p-4">
                    <h3 className="font-semibold">{room.name}</h3>
                    <p className="text-sm text-ink-700">
                      {[
                        room.bedConfig,
                        room.sizeSqm ? t('size', { size: room.sizeSqm }) : null,
                        t('upTo', { count: room.maxOccupancy }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {roomDescription(room, locale) && (
                      <p className="line-clamp-3 text-sm text-stone-600">
                        {roomDescription(room, locale)}
                      </p>
                    )}
                    <Link
                      href={`/${org}/${code}/rooms?${stayToSearch(stay, { room: room.roomTypeId })}`}
                      className="mt-2 inline-block text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      {t('seeRooms')} →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="grid gap-6 sm:grid-cols-2">
          {hotel.amenities.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold">{t('amenities')}</h2>
              <ul className="flex flex-wrap gap-2">
                {hotel.amenities.map((item) => (
                  <li key={item} className="rounded-full bg-sunk px-3 py-1 text-sm text-ink-700">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-1 text-sm text-ink-700">
            <h2 className="mb-2 text-lg font-semibold text-ink-900">{t('location')}</h2>
            <p>
              {t('checkInFrom', { time: clock(hotel.checkInTime) })} ·{' '}
              {t('checkOutBy', { time: clock(hotel.checkOutTime) })}
            </p>
            {hotel.phone && (
              <p>
                <a href={`tel:${hotel.phone}`} className="text-brand-600">
                  {t('call', { phone: hotel.phone })}
                </a>
              </p>
            )}
            {maps && (
              <p>
                <a href={maps} target="_blank" rel="noreferrer" className="text-brand-600">
                  {t('openInMaps')}
                </a>
              </p>
            )}
          </div>
        </section>
      </div>
    </Shell>
  );
}
