import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { RatePlanList } from '@/components/rate-plan-list';
import { addDays, businessDate } from '@/lib/dates';

/** Same window the inventory grid opens on, so the two line up. */
const DEFAULT_WINDOW_DAYS = 21;

export default async function RatePlansPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const [t, ratePlans, roomTypes, properties, me] = await Promise.all([
    getTranslations('ratePlans'),
    api.ratePlans(propertyId),
    api.roomTypes(propertyId),
    api.properties(),
    api.me(),
  ]);

  const property = properties.find((candidate) => candidate.id === propertyId);
  // The property's own timezone, not the server's: a Bangkok hotel viewed from
  // us-central1 must not default to yesterday.
  const from = businessDate(property?.timezone ?? 'Asia/Bangkok');

  const canEdit = me.capabilities.includes('rateplan:update');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      <RatePlanList
        propertyId={propertyId}
        ratePlans={ratePlans}
        roomTypes={roomTypes.filter((roomType) => roomType.isActive)}
        currency={property?.currency ?? 'THB'}
        defaultFrom={from}
        defaultTo={addDays(from, DEFAULT_WINDOW_DAYS)}
        canEdit={canEdit}
      />
    </div>
  );
}
