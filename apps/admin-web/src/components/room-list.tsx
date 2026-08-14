'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import type { Room, RoomType } from '@/lib/api';
import { createRoom, updateRoom } from '@/app/properties/[propertyId]/rooms/actions';

const STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'] as const;

const STATUS_STYLE: Record<string, string> = {
  CLEAN: 'bg-emerald-50 text-emerald-700',
  DIRTY: 'bg-amber-50 text-amber-700',
  INSPECTED: 'bg-sky-50 text-sky-700',
  OUT_OF_ORDER: 'bg-rose-50 text-rose-700',
};

export function RoomList({
  propertyId,
  rooms,
  roomTypes,
  canEdit,
}: {
  propertyId: string;
  rooms: Room[];
  roomTypes: RoomType[];
  canEdit: boolean;
}) {
  const t = useTranslations('rooms');
  const housekeeping = useTranslations('housekeeping');

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const roomTypeById = new Map(roomTypes.map((roomType) => [roomType.id, roomType]));

  function setStatus(room: Room, housekeepingStatus: string) {
    setError(null);
    startTransition(async () => {
      const result = await updateRoom(propertyId, room.id, { housekeepingStatus });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  function toggleService(room: Room) {
    setError(null);
    startTransition(async () => {
      const result = await updateRoom(propertyId, room.id, { isActive: !room.isActive });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  if (roomTypes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink-700">{t('needRoomType')}</p>
        <Link
          href={`/properties/${propertyId}/room-types`}
          className="mt-4 inline-block rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('roomType')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* The single most common misunderstanding about this screen, said before
          anyone can act on it. */}
      <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800">{t('neverAffects')}</p>

      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setAdding(true)}
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

      {rooms.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink-700">{t('empty')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
                <th className="px-3 py-2 font-medium">{t('roomNumber')}</th>
                <th className="px-3 py-2 font-medium">{t('floor')}</th>
                <th className="px-3 py-2 font-medium">{t('roomType')}</th>
                <th className="px-3 py-2 font-medium">{t('housekeeping')}</th>
                <th className="px-3 py-2 font-medium">{t('inService')}</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr
                  key={room.id}
                  className={`border-b border-stone-100 last:border-0 ${
                    room.isActive ? '' : 'bg-sunk/60 text-stone-400'
                  }`}
                >
                  <td className="px-3 py-2 font-medium text-ink-800">{room.roomNumber}</td>
                  <td className="px-3 py-2 text-stone-600">{room.floor ?? '—'}</td>
                  <td className="px-3 py-2 text-stone-600">
                    {roomTypeById.get(room.roomTypeId)?.name ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <select
                        aria-label={`${t('housekeeping')} — ${room.roomNumber}`}
                        value={room.housekeepingStatus}
                        disabled={pending}
                        onChange={(event) => setStatus(room, event.target.value)}
                        className={`rounded-md border-0 px-2 py-1 text-xs font-medium ${
                          STATUS_STYLE[room.housekeepingStatus] ?? 'bg-sunk text-ink-700'
                        }`}
                      >
                        {STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {housekeeping(status)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_STYLE[room.housekeepingStatus] ?? 'bg-sunk text-ink-700'
                        }`}
                      >
                        {housekeeping(room.housekeepingStatus)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-600">
                    {room.isActive ? t('inService') : t('outOfService')}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => toggleService(room)}
                        className="rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
                      >
                        {room.isActive ? t('takeOutOfService') : t('returnToService')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && rooms.length > 0 && <p className="text-xs text-stone-400">{t('noDelete')}</p>}

      {adding && (
        <AddRoomDialog
          propertyId={propertyId}
          roomTypes={roomTypes}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function AddRoomDialog({
  propertyId,
  roomTypes,
  onClose,
}: {
  propertyId: string;
  roomTypes: RoomType[];
  onClose: () => void;
}) {
  const t = useTranslations('rooms');

  const [roomTypeId, setRoomTypeId] = useState(roomTypes[0]?.id ?? '');
  const [roomNumber, setRoomNumber] = useState('');
  const [floor, setFloor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const result = await createRoom(propertyId, {
      roomTypeId,
      roomNumber,
      floor: floor.trim() || null,
    });
    setSaving(false);

    if (!result.ok) {
      setError(
        result.error?.code === 'CONFLICT'
          ? t('numberTaken')
          : (result.error?.message ?? t('failed')),
      );
      return;
    }
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('add')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-stone-200/70 bg-white shadow-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-ink-900">{t('add')}</h2>

        <div>
          <label htmlFor="room-type" className="mb-1 block text-sm font-medium text-ink-700">
            {t('roomType')}
          </label>
          <select
            id="room-type"
            value={roomTypeId}
            onChange={(event) => setRoomTypeId(event.target.value)}
            required
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {roomTypes.map((roomType) => (
              <option key={roomType.id} value={roomType.id}>
                {roomType.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="room-number" className="mb-1 block text-sm font-medium text-ink-700">
              {t('roomNumber')}
            </label>
            <input
              id="room-number"
              value={roomNumber}
              onChange={(event) => setRoomNumber(event.target.value)}
              required
              maxLength={32}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="101"
            />
          </div>
          <div>
            <label htmlFor="room-floor" className="mb-1 block text-sm font-medium text-ink-700">
              {t('floor')}
            </label>
            <input
              id="room-floor"
              value={floor}
              onChange={(event) => setFloor(event.target.value)}
              maxLength={32}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="1"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}
