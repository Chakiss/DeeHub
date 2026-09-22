'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import type { AssignableRoom } from '@/lib/api';
import { assignRoom } from '@/app/properties/[propertyId]/rooms/actions';
import { listAssignableRooms } from '@/app/properties/[propertyId]/reservations/actions';

/**
 * The room a stay is in, changeable from the booking itself.
 *
 * Before this, the only way to put a booking in a room was the stay view's
 * worklist — a different screen from the one the desk has open when the
 * guest is standing there. The picker offers the rooms free on the stay's own
 * nights, its own type first; a room of another type is an upgrade and is
 * listed as one. The API decides at the write, so a room two desks were both
 * offered is refused for the second with a message naming the dates.
 */
export function StayRoomPicker({
  propertyId,
  stayId,
  roomTypeId,
  checkIn,
  checkOut,
  assignedRoomId,
  assignedRoomNumber,
  status,
}: {
  propertyId: string;
  stayId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  assignedRoomId: string | null;
  assignedRoomNumber: string | null;
  status: string;
}) {
  const t = useTranslations('reservations');
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [rooms, setRooms] = useState<AssignableRoom[] | null>(null);
  const [roomId, setRoomId] = useState(assignedRoomId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A guest who has left, or a booking that will never arrive, has no room to
  // change. The API refuses those too; this only avoids offering the click.
  const changeable = ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(status);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    setRooms(null);
    void listAssignableRooms(propertyId, checkIn, checkOut).then((result) => {
      if (cancelled) return;
      if (!result.ok || !result.rooms) {
        setError(result.error?.message ?? null);
        setRooms([]);
        return;
      }
      setRooms(result.rooms);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, propertyId, checkIn, checkOut]);

  function save(nextRoomId: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await assignRoom(propertyId, stayId, nextRoomId);
      if (!result.ok) {
        setError(result.error?.message ?? t('staleData'));
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  const sameType = (rooms ?? []).filter((room) => room.roomTypeId === roomTypeId);
  const otherType = (rooms ?? []).filter((room) => room.roomTypeId !== roomTypeId);
  const label = (room: AssignableRoom) =>
    room.housekeepingStatus === 'DIRTY'
      ? `${room.roomNumber} (${t('roomDirty')})`
      : room.roomNumber;

  return (
    <div>
      <dt className="text-xs text-stone-500">{t('assignedRoom')}</dt>
      <dd className="text-sm text-ink-800">
        {!editing && (
          <span className="flex flex-wrap items-center gap-2">
            <span className={assignedRoomNumber ? 'font-medium' : 'text-stone-500'}>
              {assignedRoomNumber ?? t('notAssigned')}
            </span>
            {changeable && (
              <button
                type="button"
                onClick={() => {
                  setRoomId(assignedRoomId ?? '');
                  setError(null);
                  setEditing(true);
                }}
                className="text-xs text-brand-700 underline-offset-2 hover:underline"
              >
                {assignedRoomId ? t('changeRoom') : t('assignRoom')}
              </button>
            )}
          </span>
        )}

        {editing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (roomId) save(roomId);
            }}
            className="mt-1 space-y-2"
          >
            <select
              aria-label={t('assignedRoom')}
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              disabled={rooms === null || pending}
              className="w-full max-w-xs rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900 disabled:bg-sunk"
            >
              {rooms === null && <option value="">{t('working')}</option>}
              {rooms !== null && (
                <>
                  {/* The room it is in now stays choosable: "keep" must be a
                      real option, not a room that vanished from the list
                      because this very stay holds it. */}
                  {assignedRoomId && assignedRoomNumber && (
                    <option value={assignedRoomId}>
                      {assignedRoomNumber} — {t('currentRoom')}
                    </option>
                  )}
                  {!assignedRoomId && <option value="">{t('assignLater')}</option>}
                  {sameType.map((room) => (
                    <option key={room.roomId} value={room.roomId}>
                      {label(room)}
                    </option>
                  ))}
                  {otherType.length > 0 && (
                    <optgroup label={t('upgradeGroup')}>
                      {otherType.map((room) => (
                        <option key={room.roomId} value={room.roomId}>
                          {label(room)} · {room.roomTypeName}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {sameType.length === 0 && otherType.length === 0 && (
                    <option value="" disabled>
                      {t('noRoomsFree')}
                    </option>
                  )}
                </>
              )}
            </select>

            {error && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={pending || !roomId || roomId === assignedRoomId}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {pending ? t('working') : t('saveRoom')}
              </button>
              {assignedRoomId && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => save(null)}
                  className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs text-ink-700 hover:bg-sunk/70 disabled:opacity-50"
                >
                  {t('releaseRoom')}
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() => setEditing(false)}
                className="rounded-md px-3 py-1.5 text-xs text-stone-600 hover:text-ink-800"
              >
                {t('keepRoom')}
              </button>
            </div>
          </form>
        )}
      </dd>
    </div>
  );
}
