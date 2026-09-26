'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { AssignableRoom, StayViewOccupancy } from '@/lib/api';
import { listAssignableRooms } from '@/app/properties/[propertyId]/reservations/actions';

/** Nights between two calendar dates. */
function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
}

/**
 * The bar, opened.
 *
 * On a phone a night is 44px wide, which is room for a name and nothing
 * else; the check-in and check-out buttons that used to sit inside the bar
 * had nowhere to go. So the bar is one tap, and this is what it opens: who,
 * where, which nights, where the booking stands, and the one or two actions
 * that make sense from there. A bottom sheet on a phone, a dialog on a desk.
 */
export function StaySheet({
  propertyId,
  stay,
  roomNumber,
  today,
  canAssign,
  pending,
  error,
  onArrive,
  onDepart,
  onRelease,
  onMove,
  onClose,
}: {
  propertyId: string;
  stay: StayViewOccupancy;
  roomNumber: string;
  today: string;
  canAssign: boolean;
  pending: boolean;
  error: string | null;
  onArrive: () => void;
  onDepart: () => void;
  onRelease: () => void;
  onMove: (roomId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('stayView');
  const name = stay.guestName ?? stay.reservationCode;
  const dueOut = stay.status === 'CHECKED_IN' && stay.checkOut <= today;
  const movable = canAssign && stay.status !== 'CHECKED_OUT' && stay.status !== 'CANCELLED';

  /*
   * Rooms free on this stay's nights, for moving the guest without a mouse —
   * the phone's equivalent of dragging the bar. Loaded when the picker is
   * opened, not when the sheet is: most taps are a check-in, not a move.
   */
  const [picking, setPicking] = useState(false);
  const [rooms, setRooms] = useState<AssignableRoom[] | null>(null);
  const [roomId, setRoomId] = useState('');
  useEffect(() => {
    if (!picking || rooms !== null) return;
    let cancelled = false;
    void listAssignableRooms(propertyId, stay.checkIn, stay.checkOut).then((result) => {
      if (cancelled) return;
      const free = (result.ok && result.rooms ? result.rooms : []).filter(
        (room) => room.roomNumber !== roomNumber,
      );
      setRooms(free);
      setRoomId(free[0]?.roomId ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [picking, rooms, propertyId, stay.checkIn, stay.checkOut, roomNumber]);

  const statusLabel =
    stay.status === 'CHECKED_IN'
      ? dueOut
        ? t('dueOut')
        : t('inHouse')
      : stay.status === 'CHECKED_OUT'
        ? t('departed')
        : stay.status === 'PENDING'
          ? t('pendingHold')
          : t('expected');

  const statusTone =
    stay.status === 'CHECKED_IN'
      ? dueOut
        ? 'bg-amber-100 text-amber-900'
        : 'bg-emerald-100 text-emerald-900'
      : stay.status === 'CHECKED_OUT'
        ? 'bg-sunk text-stone-600'
        : stay.status === 'PENDING'
          ? 'bg-amber-50 text-amber-800'
          : 'bg-brand-100 text-brand-800';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full space-y-4 rounded-t-2xl border border-stone-200/70 bg-white p-5 shadow-lg sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-stone-500">{t('stayDetails')}</p>
            <h2 className="truncate text-lg font-medium text-ink-900">{name}</h2>
            <p className="tabular text-xs text-stone-500">
              {stay.reservationCode} · {roomNumber}
              {stay.upgraded && (
                <span className="ml-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] uppercase text-violet-800">
                  {t('upgraded')}
                </span>
              )}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusTone}`}>
            {statusLabel}
          </span>
        </div>

        <p className="tabular text-sm text-ink-800">
          {stay.checkIn} → {stay.checkOut}
          <span className="ml-2 text-stone-500">
            {t('nights', { count: nightsBetween(stay.checkIn, stay.checkOut) })}
          </span>
        </p>

        {dueOut && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('dueOutHint', { date: stay.checkOut })}
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {picking && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (roomId) onMove(roomId);
            }}
            className="flex flex-wrap items-end gap-2 rounded-lg bg-sunk p-3"
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-xs text-stone-500">{t('moveRoom')}</span>
              <select
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
                disabled={rooms === null}
                className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
              >
                {rooms === null && <option value="">{t('loadingRooms')}</option>}
                {rooms?.map((room) => (
                  <option key={room.roomId} value={room.roomId}>
                    {room.roomNumber}
                    {room.housekeepingStatus === 'DIRTY' ? ` (${t('dirty')})` : ''}
                    {' — '}
                    {room.roomTypeName}
                  </option>
                ))}
              </select>
              {rooms !== null && rooms.length === 0 && (
                <span className="mt-1 block text-xs text-rose-700">{t('noRoomsFree')}</span>
              )}
            </label>
            <button
              type="submit"
              disabled={pending || !roomId}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {t('move')}
            </button>
          </form>
        )}

        <div className="flex flex-wrap gap-2">
          {canAssign && stay.status === 'CONFIRMED' && (
            <button
              type="button"
              disabled={pending}
              onClick={onArrive}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {t('checkIn')}
            </button>
          )}
          {canAssign && stay.status === 'CHECKED_IN' && (
            <button
              type="button"
              disabled={pending}
              onClick={onDepart}
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
            >
              {t('checkOut')}
            </button>
          )}
          {movable && !picking && (
            <button
              type="button"
              disabled={pending}
              onClick={() => setPicking(true)}
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
            >
              {t('moveRoom')}
            </button>
          )}
          <Link
            href={`/properties/${propertyId}/reservations/${stay.reservationId}`}
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('openReservation')}
          </Link>
          {/* Releasing a room only makes sense before arrival; afterwards the
              assignment is history. */}
          {canAssign && stay.status === 'CONFIRMED' && (
            <button
              type="button"
              disabled={pending}
              onClick={onRelease}
              title={t('noRoomForNights')}
              className="rounded-md px-3 py-2 text-sm text-stone-500 hover:bg-sunk/70 disabled:opacity-60"
            >
              {t('release')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-2 text-sm text-stone-500 hover:bg-sunk/70"
          >
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
