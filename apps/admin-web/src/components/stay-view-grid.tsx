'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { AssignableRoom, StayView, StayViewOccupancy } from '@/lib/api';
import { assignRoom, checkIn, checkOut } from '@/app/properties/[propertyId]/rooms/actions';
import { listAssignableRooms } from '@/app/properties/[propertyId]/reservations/actions';
import { addDays, dayLabel, isWeekend, weekdayLabel } from '@/lib/dates';

const HOUSEKEEPING_DOT: Record<string, string> = {
  CLEAN: 'bg-emerald-500',
  DIRTY: 'bg-amber-500',
  INSPECTED: 'bg-sky-500',
  OUT_OF_ORDER: 'bg-rose-500',
};

/**
 * Room × date, with a bar per stay.
 *
 * This is the screen the competitor calls "Stay View", and it is deliberately
 * not the inventory grid: nothing here feeds availability. A hotel can be sold
 * out with every room empty on this screen, because allotment is a commercial
 * decision and a room is a place to sleep (ADR-0002).
 */
export function StayViewGrid({
  propertyId,
  view,
  from,
  windowDays,
  canAssign,
}: {
  propertyId: string;
  view: StayView;
  from: string;
  windowDays: number;
  canAssign: boolean;
}) {
  const t = useTranslations('stayView');
  const housekeeping = useTranslations('housekeeping');

  const [assigning, setAssigning] = useState<
    (StayViewOccupancy & { roomTypeId: string; roomTypeName: string }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * Rooms grouped by type, the way a hotel thinks of its floors: "the
   * Deluxes" are one thing to look at, and a booking needing a Deluxe is
   * found under that heading rather than by scanning every row. Groups fold
   * per browser, remembered locally — a 40-room hotel on a phone wants the
   * Standards out of the way while it deals with a Suite.
   */
  const groups = useMemo(() => {
    const byType = new Map<
      string,
      { roomTypeId: string; roomTypeName: string; rooms: StayView['rooms']; needing: number }
    >();
    for (const room of view.rooms) {
      const group = byType.get(room.roomTypeId) ?? {
        roomTypeId: room.roomTypeId,
        roomTypeName: room.roomTypeName,
        rooms: [],
        needing: 0,
      };
      group.rooms.push(room);
      byType.set(room.roomTypeId, group);
    }
    for (const stay of view.unassigned) {
      const group = byType.get(stay.roomTypeId);
      if (group) group.needing += 1;
    }
    return [...byType.values()].sort((a, b) => a.roomTypeName.localeCompare(b.roomTypeName));
  }, [view]);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const storageKey = `deehub.stayView.collapsed.${propertyId}`;
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) setCollapsed(new Set(JSON.parse(stored) as string[]));
    } catch {
      // Private mode or blocked storage: every group simply starts open.
    }
  }, [storageKey]);

  function toggleGroup(roomTypeId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(roomTypeId)) next.delete(roomTypeId);
      else next.add(roomTypeId);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // Not remembering is fine.
      }
      return next;
    });
  }

  function arrive(stay: StayViewOccupancy) {
    setError(null);
    startTransition(async () => {
      const result = await checkIn(propertyId, stay.reservationId, stay.version);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  function depart(stay: StayViewOccupancy) {
    setError(null);
    startTransition(async () => {
      const result = await checkOut(propertyId, stay.reservationId, stay.version);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  function release(stayId: string) {
    setError(null);
    startTransition(async () => {
      const result = await assignRoom(propertyId, stayId, null);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  if (view.rooms.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink-700">{t('empty')}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('emptyHint')}</p>
        <Link
          href={`/properties/${propertyId}/rooms`}
          className="mt-4 inline-block rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('goToRooms')}
        </Link>
      </div>
    );
  }

  const index = new Map(view.dates.map((date, position) => [date, position]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`?from=${addDays(from, -windowDays)}`}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70"
        >
          ← {t('previous')}
        </Link>
        <Link
          href={`?from=${addDays(from, windowDays)}`}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70"
        >
          {t('next')} →
        </Link>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* The front desk's worklist: booked, in the window, nowhere to sleep. */}
      <section className="rounded-2xl border border-stone-200/70 bg-white shadow-card p-4">
        <h2 className="text-sm font-medium text-ink-800">
          {t('unassigned')}
          {view.unassigned.length > 0 && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
              {view.unassigned.length}
            </span>
          )}
        </h2>

        {view.unassigned.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">{t('unassignedEmpty')}</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {view.unassigned.map((stay) => (
              <li
                key={stay.stayId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-50/60 px-3 py-2 text-sm"
              >
                <Link
                  href={`/properties/${propertyId}/reservations/${stay.reservationId}`}
                  className="font-medium text-ink-800 underline-offset-2 hover:underline"
                >
                  {stay.guestName ?? stay.reservationCode}
                </Link>
                <span className="text-xs text-stone-500">{stay.roomTypeName}</span>
                <span className="tabular text-xs text-stone-500">
                  {stay.checkIn} → {stay.checkOut}
                </span>
                {canAssign && (
                  <button
                    type="button"
                    onClick={() => setAssigning(stay)}
                    className="ml-auto rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700"
                  >
                    {t('assign')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Scrolling stays inside the grid: the page body must never move. */}
      <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-[170px] border-b border-r border-stone-200 bg-sunk px-3 py-2 text-left font-medium text-stone-600">
                {t('title')}
              </th>
              {view.dates.map((date) => (
                <th
                  key={date}
                  className={`min-w-[44px] border-b border-stone-200 px-1 py-2 text-center font-medium ${
                    isWeekend(date) ? 'bg-sunk text-ink-700' : 'bg-sunk text-stone-600'
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wide text-stone-400">
                    {weekdayLabel(date)}
                  </div>
                  <div className="tabular text-xs">{dayLabel(date)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => [
              <tr key={`type-${group.roomTypeId}`}>
                <th
                  colSpan={view.dates.length + 1}
                  className="border-b border-stone-200 bg-sunk/80 px-3 py-1.5 text-left"
                >
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.roomTypeId)}
                    aria-expanded={!collapsed.has(group.roomTypeId)}
                    className="flex w-full items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-700"
                  >
                    <span aria-hidden className="w-3 text-stone-400">
                      {collapsed.has(group.roomTypeId) ? '▸' : '▾'}
                    </span>
                    <span>{group.roomTypeName}</span>
                    <span className="font-normal normal-case tracking-normal text-stone-500">
                      {t('roomsInType', { count: group.rooms.length })}
                    </span>
                    {group.needing > 0 && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-800">
                        {t('needRoomInType', { count: group.needing })}
                      </span>
                    )}
                  </button>
                </th>
              </tr>,
              ...(collapsed.has(group.roomTypeId) ? [] : group.rooms).map((room) => (
              <tr key={room.roomId} className="group">
                <th className="sticky left-0 z-10 border-b border-r border-stone-200 bg-white px-3 py-2 text-left font-medium text-ink-800 group-hover:bg-sunk/70">
                  <span className="flex items-center gap-2">
                    <span
                      aria-label={housekeeping(room.housekeepingStatus)}
                      title={housekeeping(room.housekeepingStatus)}
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        HOUSEKEEPING_DOT[room.housekeepingStatus] ?? 'bg-stone-300'
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">
                        {room.roomNumber}
                        {!room.isActive && (
                          <span className="ml-1 text-xs font-normal text-rose-600">
                            {t('outOfService')}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs font-normal text-stone-400">
                        {room.roomTypeName}
                      </span>
                    </span>
                  </span>
                </th>

                {/* One cell per night, with the bar drawn on its first night.
                    A table keeps the columns aligned with the header without
                    measuring anything in JavaScript. */}
                {view.dates.map((date) => {
                  const starting = room.stays.find((stay) => stay.checkIn === date);
                  const covered = room.stays.find(
                    (stay) => stay.checkIn < date && stay.checkOut > date,
                  );

                  if (covered) return null;

                  if (!starting) {
                    return (
                      <td
                        key={date}
                        className={`border-b border-stone-100 px-1 py-2 ${
                          isWeekend(date) ? 'bg-sunk/60' : ''
                        }`}
                      />
                    );
                  }

                  // Clamp to the window: a stay running past the edge draws to
                  // the edge rather than off it.
                  const start = index.get(date) ?? 0;
                  const end = index.get(starting.checkOut) ?? view.dates.length;
                  const span = Math.max(1, end - start);

                  return (
                    <td
                      key={date}
                      colSpan={span}
                      className="border-b border-stone-100 px-0.5 py-1.5"
                    >
                      <span
                        title={`${starting.reservationCode} · ${starting.checkIn} → ${starting.checkOut}`}
                        className={`flex items-center gap-1 truncate rounded px-2 py-1 text-xs font-medium ${
                          starting.status === 'CHECKED_OUT'
                            ? 'bg-sunk text-stone-500'
                            : starting.status === 'CHECKED_IN'
                              ? 'bg-emerald-100 text-emerald-900'
                              : starting.upgraded
                                ? 'bg-violet-100 text-violet-800'
                                : 'bg-brand-100 text-brand-800'
                        }`}
                      >
                        <span className="truncate">
                          {starting.guestName ?? starting.reservationCode}
                        </span>
                        {starting.upgraded && (
                          <span className="shrink-0 text-[10px] uppercase">{t('upgraded')}</span>
                        )}
                        {canAssign && (
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            {/* The action the front desk needs on this row,
                                driven by where the booking actually is. */}
                            {starting.status === 'CONFIRMED' && (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => arrive(starting)}
                                className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-white disabled:opacity-60"
                              >
                                {t('checkIn')}
                              </button>
                            )}
                            {starting.status === 'CHECKED_IN' && (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => depart(starting)}
                                className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-white disabled:opacity-60"
                              >
                                {t('checkOut')}
                              </button>
                            )}
                            {starting.status === 'CHECKED_OUT' && (
                              <span className="text-[10px] text-stone-500">{t('departed')}</span>
                            )}
                            {/* Releasing a room only makes sense before arrival;
                                afterwards the assignment is history. */}
                            {starting.status === 'CONFIRMED' && (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => release(starting.stayId)}
                                aria-label={`${t('release')} ${starting.reservationCode}`}
                                className="rounded px-1 text-[10px] text-stone-500 hover:bg-white/60 disabled:opacity-60"
                              >
                                ✕
                              </button>
                            )}
                          </span>
                        )}
                      </span>
                    </td>
                  );
                })}
              </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      {assigning && (
        <AssignDialog
          propertyId={propertyId}
          stay={assigning}
          view={view}
          onClose={() => setAssigning(null)}
        />
      )}
    </div>
  );
}

function AssignDialog({
  propertyId,
  stay,
  view,
  onClose,
}: {
  propertyId: string;
  stay: StayViewOccupancy & { roomTypeId: string; roomTypeName: string };
  view: StayView;
  onClose: () => void;
}) {
  const t = useTranslations('stayView');
  void view;

  /*
   * Only rooms free on this stay's own nights, from the API rather than
   * filtered here from the window: a stay can run past the window's edge,
   * and a room that looks empty in a fortnight can be taken the night after.
   * Matching type first — an upgrade should be a deliberate choice, not the
   * top of the list. Advisory still: the write is where a clash is refused.
   */
  const [rooms, setRooms] = useState<AssignableRoom[] | null>(null);
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listAssignableRooms(propertyId, stay.checkIn, stay.checkOut).then((result) => {
      if (cancelled) return;
      const free = result.ok && result.rooms ? result.rooms : [];
      if (!result.ok) setError(result.error?.message ?? t('failed'));
      setRooms(free);
      setRoomId(
        free.find((room) => room.roomTypeId === stay.roomTypeId)?.roomId ??
          free[0]?.roomId ??
          '',
      );
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, stay.checkIn, stay.checkOut, stay.roomTypeId, t]);

  const sameType = (rooms ?? []).filter((room) => room.roomTypeId === stay.roomTypeId);
  const otherType = (rooms ?? []).filter((room) => room.roomTypeId !== stay.roomTypeId);
  const label = (room: AssignableRoom) =>
    room.housekeepingStatus === 'DIRTY' ? `${room.roomNumber} (${t('dirty')})` : room.roomNumber;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('assignTo', { guest: stay.guestName ?? stay.reservationCode })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setSaving(true);
          const result = await assignRoom(propertyId, stay.stayId, roomId);
          setSaving(false);
          if (!result.ok) {
            // A conflict here means the room is taken for overlapping nights,
            // and the API's message names the dates.
            setError(result.error?.message ?? t('failed'));
            return;
          }
          onClose();
        }}
        className="w-full max-w-md space-y-4 rounded-2xl border border-stone-200/70 bg-white shadow-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-ink-900">
          {t('assignTo', { guest: stay.guestName ?? stay.reservationCode })}
        </h2>
        <p className="tabular text-sm text-stone-500">
          {stay.checkIn} → {stay.checkOut} · {stay.roomTypeName}
        </p>

        <div>
          <label htmlFor="assign-room" className="mb-1 block text-sm font-medium text-ink-700">
            {t('choose')}
          </label>
          <select
            id="assign-room"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            required
            disabled={rooms === null}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk"
          >
            {rooms === null && <option value="">{t('loadingRooms')}</option>}
            {sameType.map((room) => (
              <option key={room.roomId} value={room.roomId}>
                {label(room)}
              </option>
            ))}
            {otherType.length > 0 && (
              <optgroup label={t('upgradeGroup')}>
                {otherType.map((room) => (
                  <option key={room.roomId} value={room.roomId}>
                    {label(room)} — {room.roomTypeName}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {rooms !== null && rooms.length === 0 && (
            <p className="mt-2 text-sm text-rose-700">{t('noRoomsFree')}</p>
          )}
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
            {t('previous')}
          </button>
          <button
            type="submit"
            disabled={saving || rooms === null || rooms.length === 0}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {t('assign')}
          </button>
        </div>
      </form>
    </div>
  );
}
