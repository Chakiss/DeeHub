import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { RoomList } from '@/components/room-list';

export default async function RoomsPage({ params }: { params: Promise<{ propertyId: string }> }) {
  const { propertyId } = await params;
  const [t, rooms, roomTypes, me] = await Promise.all([
    getTranslations('rooms'),
    api.rooms(propertyId),
    api.roomTypes(propertyId),
    api.me(),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      <RoomList
        propertyId={propertyId}
        rooms={rooms}
        roomTypes={roomTypes.filter((roomType) => roomType.isActive)}
        canEdit={me.capabilities.includes('room:update')}
      />
    </div>
  );
}
