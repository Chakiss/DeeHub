import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { BookingSourceList } from '@/components/booking-source-list';

export default async function BookingSourcesPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const [t, sources, me] = await Promise.all([
    getTranslations('bookingSources'),
    api.bookingSources(propertyId),
    api.me(),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      <BookingSourceList
        propertyId={propertyId}
        sources={sources}
        canEdit={me.capabilities.includes('channel:update')}
      />
    </div>
  );
}
