import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { businessDate } from '@/lib/dates';
import { BookingForm } from '@/components/booking-form';

export default async function NewReservationPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const t = await getTranslations('reservations');

  const [properties, roomTypes, ratePlans] = await Promise.all([
    api.properties(),
    api.roomTypes(propertyId),
    api.ratePlans(propertyId),
  ]);
  const property = properties.find((candidate) => candidate.id === propertyId);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/properties/${propertyId}/reservations`}
          className="text-sm text-stone-500 hover:text-ink-800"
        >
          ← {t('backToList')}
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink-900">{t('newTitle')}</h1>
        <p className="text-sm text-stone-500">{t('newSubtitle')}</p>
      </div>

      <BookingForm
        propertyId={propertyId}
        currency={property?.currency ?? 'THB'}
        // The property's own date, never the server's: a Bangkok hotel booked
        // from us-central1 must not default to yesterday (ADR-0003).
        today={businessDate(property?.timezone ?? 'Asia/Bangkok')}
        roomTypes={roomTypes.filter((roomType) => roomType.isActive)}
        ratePlans={ratePlans}
      />
    </div>
  );
}
