import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { PropertySettingsForm } from '@/components/property-settings-form';
import { MediaGallery } from '@/components/media-gallery';

/**
 * What the hotel says about itself: address, contact, description, where it
 * is on the map, and its photos. This is the copy a guest reads on the booking
 * page and the identity Google matches a listing against — so it lives with
 * the people who own the property (`property:update`, MANAGER and above), not
 * with the front desk.
 */
export default async function PropertySettingsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const [t, property, media, roomTypes, me] = await Promise.all([
    getTranslations('settings'),
    api.property(propertyId),
    api.media(propertyId),
    api.roomTypes(propertyId),
    api.me(),
  ]);

  const canEdit = me.capabilities.includes('property:update');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      <PropertySettingsForm propertyId={propertyId} property={property} canEdit={canEdit} />

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium text-ink-900">{t('photos')}</h2>
          <p className="text-sm text-stone-500">{t('photosHint')}</p>
        </div>

        <MediaGallery
          propertyId={propertyId}
          title={t('propertyPhotos')}
          kind="PROPERTY"
          roomTypeId={null}
          items={media.items.filter((item) => item.kind === 'PROPERTY')}
          storageAvailable={media.storageAvailable}
          limits={media.limits}
          canEdit={canEdit}
        />

        {roomTypes
          .filter((roomType) => roomType.isActive)
          .map((roomType) => (
            <MediaGallery
              key={roomType.id}
              propertyId={propertyId}
              title={roomType.name}
              kind="ROOM_TYPE"
              roomTypeId={roomType.id}
              items={media.items.filter((item) => item.roomTypeId === roomType.id)}
              storageAvailable={media.storageAvailable}
              limits={media.limits}
              canEdit={canEdit}
            />
          ))}
      </section>
    </div>
  );
}
