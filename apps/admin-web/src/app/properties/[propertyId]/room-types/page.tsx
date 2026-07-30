import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { RoomTypeList } from '@/components/room-type-list';

export default async function RoomTypesPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const [t, roomTypes, me] = await Promise.all([
    getTranslations('roomTypes'),
    api.roomTypes(propertyId),
    api.me(),
  ]);

  // Hides the controls a user cannot use. The server still authorizes every
  // request — this only avoids offering a button that would 403.
  const canEdit = me.capabilities.includes('roomtype:update');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      <RoomTypeList propertyId={propertyId} roomTypes={roomTypes} canEdit={canEdit} />
    </div>
  );
}
