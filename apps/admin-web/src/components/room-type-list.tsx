'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { RoomType } from '@/lib/api';
import { updateRoomType } from '@/app/properties/[propertyId]/room-types/actions';
import { RoomTypeForm } from './room-type-form';

export function RoomTypeList({
  propertyId,
  roomTypes,
  canEdit,
}: {
  propertyId: string;
  roomTypes: RoomType[];
  canEdit: boolean;
}) {
  const t = useTranslations('roomTypes');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RoomType | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleSelling(roomType: RoomType) {
    setError(null);
    startTransition(async () => {
      const result = await updateRoomType(propertyId, roomType.id, {
        isActive: !roomType.isActive,
      });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('add')}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {roomTypes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink-700">{t('empty')}</p>
          {/* The distinction people get wrong on day one: a room type is a
              category, not a physical room. */}
          <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-white shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
                <th className="px-3 py-2 font-medium">{t('code')}</th>
                <th className="px-3 py-2 font-medium">{t('name')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('standardOccupancy')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('maxOccupancy')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('maxAdults')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('maxChildren')}</th>
                <th className="px-3 py-2 font-medium">{t('active')}</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {roomTypes.map((roomType) => (
                <tr
                  key={roomType.id}
                  className={`border-b border-stone-100 last:border-0 ${
                    roomType.isActive ? '' : 'bg-sunk/60 text-stone-400'
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{roomType.code}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink-800">{roomType.name}</div>
                    {roomType.description && (
                      <div className="text-xs text-stone-400">{roomType.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">
                    {roomType.standardOccupancy}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{roomType.maxOccupancy}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{roomType.maxAdults}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{roomType.maxChildren}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        roomType.isActive
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-stone-200 text-stone-600'
                      }`}
                    >
                      {roomType.isActive ? t('active') : t('inactive')}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditing(roomType)}
                          className="rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70"
                        >
                          {t('edit')}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => toggleSelling(roomType)}
                          className="rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
                        >
                          {roomType.isActive ? t('deactivate') : t('activate')}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stated rather than left to be discovered by looking for a delete
          button that is not there. */}
      {canEdit && roomTypes.length > 0 && <p className="text-xs text-stone-400">{t('noDelete')}</p>}

      {creating && <RoomTypeForm propertyId={propertyId} onClose={() => setCreating(false)} />}
      {editing && (
        <RoomTypeForm propertyId={propertyId} roomType={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
