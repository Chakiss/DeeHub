'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { AssignableRoom, StayView, StayViewOccupancy } from '@/lib/api';
import { assignRoom, checkIn, checkOut } from '@/app/properties/[propertyId]/rooms/actions';
import { listAssignableRooms } from '@/app/properties/[propertyId]/reservations/actions';
import { addDays, dayLabel, isWeekend, weekdayLabel } from '@/lib/dates';
import { freeRoomsPerNight, layoutStays, type StayBar } from '@/lib/stay-layout';
import { badgeKeyFor } from '@/lib/channel-badge';
import { StaySheet } from '@/components/stay-sheet';
import { ChannelBadge } from '@/components/channel-badge';

const HOUSEKEEPING_DOT: Record<string, string> = {
  CLEAN: 'bg-emerald-500',
  DIRTY: 'bg-amber-500',
  INSPECTED: 'bg-sky-500',
  OUT_OF_ORDER: 'bg-rose-500',
};

/** One lane of bars is this tall; a row grows when stays overlap. */
const LANE_PX = 32;

/**
 * Room × night, with a bar per stay.
 *
 * This is the screen the competitor calls "Stay View", and it is deliberately
 * not the inventory grid: nothing here feeds availability. A hotel can be sold
 * out with every room empty on this screen, because allotment is a commercial
 * decision and a room is a place to sleep (ADR-0002).
 *
 * Drawn with CSS grid and absolutely positioned bars rather than a table with
 * colSpan, for two reasons the front desk feels directly. A table cell is a
 * whole night, so a bar could not start in the middle of its check-in day the
 * way every other PMS draws it, and two bookings turning over on one day were
 * indistinguishable from one long stay. And a stay that began before the
 * window's first night had no starting cell, so it was skipped — which
 * removed cells from the row and shifted every later booking onto the wrong
 * day. The geometry now lives in `layoutStays`, where it is tested.
 */
export function StayViewGrid({
  propertyId,
  view,
  from,
  today,
  canAssign,
}: {
  propertyId: string;
  view: StayView;
  from: string;
  today: string;
  canAssign: boolean;
}) {
  const t = useTranslations('stayView');
  const housekeeping = useTranslations('housekeeping');
  const router = useRouter();

  const [assigning, setAssigning] = useState<
    (StayViewOccupancy & { roomTypeId: string; roomTypeName: string }) | null
  >(null);
  const [opened, setOpened] = useState<{ stay: StayViewOccupancy; roomNumber: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * Dragging a bar onto another row moves the guest. Mouse only: on a touch
   * screen a vertical drag is how the page scrolls, and the sheet offers a
   * room picker instead. A press that never moves is a click and opens the
   * sheet as before — the `moved` flag is what tells the two apart.
   */
  interface Drag {
    stay: StayViewOccupancy;
    fromRoomId: string;
    /** Where the press began: a drag is a move of more than a few px from here. */
    startY: number;
    x: number;
    y: number;
    moved: boolean;
    overRoomId: string | null;
    overRoomNumber: string | null;
  }
  const [drag, setDrag] = useState<Drag | null>(null);
  // The listeners below read and write through the ref so that the drop
  // handler can act on the final position without doing work inside a state
  // updater, and so a click that follows a drag can tell it was a drag.
  const dragRef = useRef<Drag | null>(null);
  const justDraggedRef = useRef(false);

  function beginDrag(next: Drag) {
    dragRef.current = next;
    setDrag(next);
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(event: PointerEvent) {
      const current = dragRef.current;
      if (!current) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-room-id]');
      const next: Drag = {
        ...current,
        x: event.clientX,
        y: event.clientY,
        moved: current.moved || Math.abs(event.clientY - current.startY) > 6,
        overRoomId: target?.dataset.roomId ?? null,
        overRoomNumber: target?.dataset.roomNumber ?? null,
      };
      dragRef.current = next;
      setDrag(next);
    }
    function onUp() {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current?.moved) return;
      // The click the browser may fire right after this release must not
      // open the sheet. It fires in the same task, so the flag is cleared on
      // the next tick — a drop onto another row fires no click at all, and
      // a sticky flag would then swallow the next real tap.
      justDraggedRef.current = true;
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 0);
      if (current.overRoomId && current.overRoomId !== current.fromRoomId) {
        move(current.stay, current.overRoomId);
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // Re-armed when a drag starts, torn down when it ends.
  }, [drag !== null]);

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
      {
        roomTypeId: string;
        roomTypeName: string;
        rooms: { room: StayView['rooms'][number]; bars: StayBar<StayViewOccupancy>[] }[];
        needing: number;
        /** Rooms with nobody in them, per night. */
        free: number[];
      }
    >();
    for (const room of view.rooms) {
      const group = byType.get(room.roomTypeId) ?? {
        roomTypeId: room.roomTypeId,
        roomTypeName: room.roomTypeName,
        rooms: [],
        needing: 0,
        free: [],
      };
      group.rooms.push({ room, bars: layoutStays(view.dates, room.stays) });
      byType.set(room.roomTypeId, group);
    }
    for (const group of byType.values()) {
      group.free = freeRoomsPerNight(
        view.dates,
        group.rooms.map(({ room }) => room),
      );
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

  // The sheet shows a stay as it was when tapped; once the server has moved
  // it on (checked in, released) the fresh view arrives and the sheet must
  // follow it or offer a button that no longer applies.
  useEffect(() => {
    if (!opened) return;
    for (const room of view.rooms) {
      const current = room.stays.find((stay) => stay.stayId === opened.stay.stayId);
      if (current) {
        if (current.version !== opened.stay.version || current.status !== opened.stay.status) {
          setOpened({ stay: current, roomNumber: room.roomNumber });
        }
        return;
      }
    }
    setOpened(null);
  }, [view, opened]);

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

  function move(stay: StayViewOccupancy, roomId: string) {
    setError(null);
    startTransition(async () => {
      const result = await assignRoom(propertyId, stay.stayId, roomId);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
      else setOpened(null);
    });
  }

  function release(stayId: string) {
    setError(null);
    startTransition(async () => {
      const result = await assignRoom(propertyId, stayId, null);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
      else setOpened(null);
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

  const columns = view.dates.length;
  const navButton =
    'rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-700 hover:bg-sunk/70';

  return (
    <div className="space-y-3">
      {/* A week at a time, "today" to come back, and a date to jump to. The
          window opens on yesterday so last night's guests — the ones the desk
          is checking out this morning — are in the picture. */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`?from=${addDays(from, -7)}`} className={navButton} aria-label={t('weekBack')}>
          ‹ 7
        </Link>
        <Link href={`?from=${addDays(today, -1)}`} className={navButton}>
          {t('today')}
        </Link>
        <Link
          href={`?from=${addDays(from, 7)}`}
          className={navButton}
          aria-label={t('weekForward')}
        >
          7 ›
        </Link>
        <input
          type="date"
          aria-label={t('jumpTo')}
          value={from}
          onChange={(event) => {
            if (event.target.value) router.push(`?from=${event.target.value}`);
          }}
          className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-ink-700"
        />
      </div>

      {error && !opened && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* The front desk's worklist: booked, in the window, nowhere to sleep.
          One quiet line when it is empty — the grid is the point of the page. */}
      {view.unassigned.length === 0 ? (
        <p className="text-xs text-stone-500">
          {t('unassigned')}: {t('unassignedEmpty')}
        </p>
      ) : (
        <section className="rounded-2xl border border-amber-200/70 bg-white shadow-card p-3">
          <h2 className="text-sm font-medium text-ink-800">
            {t('unassigned')}
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
              {view.unassigned.length}
            </span>
          </h2>
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
        </section>
      )}

      {/* Scrolling stays inside the grid: the page body must never move.
          Column widths are CSS variables so header and rows agree without
          measuring anything; a phone shows a week, a desk shows the fortnight. */}
      <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card [--col:42px] [--room:74px] sm:[--col:60px] sm:[--room:88px]">
        <div
          role="table"
          aria-label={t('title')}
          className="text-sm"
          style={{ width: `calc(var(--room) + var(--col) * ${String(columns)})` }}
        >
          <div role="row" className="flex">
            <div
              role="columnheader"
              className="sticky left-0 z-20 w-[var(--room)] shrink-0 border-b border-r border-stone-200 bg-sunk px-2 py-1.5 text-left text-[11px] font-medium text-stone-500"
            >
              {t('roomColumn')}
            </div>
            {view.dates.map((date, position) => {
              const isToday = date === today;
              return (
                <div
                  key={date}
                  role="columnheader"
                  aria-current={isToday ? 'date' : undefined}
                  className={`w-[var(--col)] shrink-0 border-b border-stone-200 py-1 text-center ${
                    isToday
                      ? 'bg-brand-100/70 text-brand-800'
                      : isWeekend(date)
                        ? 'bg-sunk text-ink-700'
                        : 'bg-sunk text-stone-600'
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wide opacity-70">
                    {weekdayLabel(date)}
                  </div>
                  <div className={`tabular text-xs ${isToday ? 'font-semibold' : ''}`}>
                    {/* The month only where it changes, or the row would be
                        twelve "Sep"s wide. */}
                    {position === 0 || date.endsWith('-01')
                      ? dayLabel(date)
                      : String(Number(date.slice(8, 10)))}
                  </div>
                </div>
              );
            })}
          </div>

          {groups.map((group) => (
            <div key={group.roomTypeId} role="rowgroup">
              <div role="row" className="flex border-b border-stone-200 bg-sunk/80">
                <div role="cell" className="sticky left-0 z-10 max-w-full px-2 py-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.roomTypeId)}
                    aria-expanded={!collapsed.has(group.roomTypeId)}
                    className="flex items-center gap-2 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-ink-700"
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
                </div>
              </div>

              {/* The desk's count — nobody in the room that night — under the
                  heading so it reads with the rooms it counts. Deliberately not
                  the sellable number; see freeRoomsPerNight. */}
              <div role="row" aria-label={`${group.roomTypeName} ${t('free')}`} className="flex">
                <div
                  role="rowheader"
                  title={t('freeHint')}
                  className="sticky left-0 z-10 flex w-[var(--room)] shrink-0 items-center border-b border-r border-stone-200 bg-sunk/40 px-1.5 text-[10px] uppercase tracking-wide text-stone-500"
                >
                  {t('free')}
                </div>
                {group.free.map((count, position) => (
                  <div
                    key={view.dates[position]}
                    role="cell"
                    className={`tabular flex h-6 w-[var(--col)] shrink-0 items-center justify-center border-b border-l border-stone-100 text-[11px] ${
                      count === 0
                        ? 'bg-rose-50 font-semibold text-rose-700'
                        : view.dates[position] === today
                          ? 'bg-brand-100/40 text-ink-700'
                          : 'bg-sunk/40 text-stone-600'
                    }`}
                  >
                    {count}
                  </div>
                ))}
              </div>

              {!collapsed.has(group.roomTypeId) &&
                group.rooms.map(({ room, bars }) => {
                  const lanes = Math.max(1, ...bars.map((bar) => bar.lane + 1));
                  return (
                    <div
                      key={room.roomId}
                      role="row"
                      aria-label={room.roomNumber}
                      data-room-id={room.roomId}
                      data-room-number={room.roomNumber}
                      className={`flex ${
                        drag?.moved && drag.overRoomId === room.roomId
                          ? drag.fromRoomId === room.roomId
                            ? ''
                            : 'bg-brand-50 ring-2 ring-inset ring-brand-400'
                          : ''
                      }`}
                    >
                      {/* Just the number: the type is the heading above, and
                          every pixel here is a night the desk cannot see. */}
                      <div
                        role="rowheader"
                        className="sticky left-0 z-10 flex w-[var(--room)] shrink-0 items-center gap-1 border-b border-r border-stone-200 bg-white px-1.5 text-[11px] font-semibold text-ink-800 sm:text-xs"
                        style={{ height: `${String(lanes * LANE_PX + 4)}px` }}
                      >
                        <span
                          aria-label={housekeeping(room.housekeepingStatus)}
                          title={housekeeping(room.housekeepingStatus)}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            HOUSEKEEPING_DOT[room.housekeepingStatus] ?? 'bg-stone-300'
                          }`}
                        />
                        <span className="truncate">{room.roomNumber}</span>
                        {!room.isActive && <span className="sr-only">{t('outOfService')}</span>}
                      </div>

                      <div
                        role="cell"
                        className="relative border-b border-stone-100"
                        style={{
                          width: `calc(var(--col) * ${String(columns)})`,
                          height: `${String(lanes * LANE_PX + 4)}px`,
                        }}
                      >
                        {view.dates.map((date, position) => (
                          <div
                            key={date}
                            aria-hidden
                            className={`absolute inset-y-0 w-[var(--col)] border-l border-stone-100 ${
                              date === today
                                ? 'bg-brand-100/40'
                                : isWeekend(date)
                                  ? 'bg-sunk/60'
                                  : !room.isActive
                                    ? 'bg-rose-50/40'
                                    : ''
                            }`}
                            style={{ left: `calc(var(--col) * ${String(position)})` }}
                          />
                        ))}

                        {bars.map((bar) => (
                          <Bar
                            key={bar.stay.stayId}
                            bar={bar}
                            today={today}
                            dragging={drag?.moved === true && drag.stay.stayId === bar.stay.stayId}
                            onOpen={() => {
                              // The click that follows a drop is not a tap.
                              if (justDraggedRef.current) return;
                              setError(null);
                              setOpened({ stay: bar.stay, roomNumber: room.roomNumber });
                            }}
                            onPointerDown={
                              canAssign &&
                              bar.stay.status !== 'CHECKED_OUT' &&
                              bar.stay.status !== 'CANCELLED'
                                ? (event) => {
                                    if (event.pointerType !== 'mouse' || event.button !== 0) return;
                                    beginDrag({
                                      stay: bar.stay,
                                      fromRoomId: room.roomId,
                                      startY: event.clientY,
                                      x: event.clientX,
                                      y: event.clientY,
                                      moved: false,
                                      overRoomId: room.roomId,
                                      overRoomNumber: room.roomNumber,
                                    });
                                  }
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>

      <Legend />
      {canAssign && <p className="hidden text-xs text-stone-400 sm:block">{t('dragHint')}</p>}

      {drag?.moved && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed z-50 rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {drag.overRoomNumber && drag.overRoomId !== drag.fromRoomId
            ? t('moveTo', { room: drag.overRoomNumber })
            : (drag.stay.guestName ?? drag.stay.reservationCode)}
        </div>
      )}

      {opened && (
        <StaySheet
          propertyId={propertyId}
          stay={opened.stay}
          roomNumber={opened.roomNumber}
          today={today}
          canAssign={canAssign}
          pending={pending}
          error={error}
          onArrive={() => arrive(opened.stay)}
          onDepart={() => depart(opened.stay)}
          onRelease={() => release(opened.stay.stayId)}
          onMove={(roomId) => move(opened.stay, roomId)}
          onClose={() => {
            setOpened(null);
            setError(null);
          }}
        />
      )}

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

function barTone(stay: StayViewOccupancy, today: string): string {
  if (stay.status === 'CHECKED_OUT') return 'bg-sunk text-stone-500';
  if (stay.status === 'CHECKED_IN') {
    // Still in the room past the morning they were due to leave: the one
    // state a desk most needs to notice, and the colour says so.
    return stay.checkOut <= today
      ? 'bg-amber-200 text-amber-950 ring-1 ring-amber-400'
      : 'bg-emerald-200 text-emerald-950';
  }
  if (stay.status === 'PENDING')
    return 'bg-amber-50 text-amber-800 ring-1 ring-dashed ring-amber-300';
  if (stay.upgraded) return 'bg-violet-100 text-violet-800';
  return 'bg-brand-100 text-brand-800';
}

/**
 * One stay on the grid. A button, because at 44px a night there is room for
 * a name and nothing else — everything it can do lives in the sheet it opens.
 * The status is read out (and matched by tests) but not printed.
 */
function Bar({
  bar,
  today,
  dragging,
  onOpen,
  onPointerDown,
}: {
  bar: StayBar<StayViewOccupancy>;
  today: string;
  dragging: boolean;
  onOpen: () => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const t = useTranslations('stayView');
  const { stay } = bar;
  const name = stay.guestName ?? stay.reservationCode;
  const status =
    stay.status === 'CHECKED_IN'
      ? stay.checkOut <= today
        ? t('dueOut')
        : t('inHouse')
      : stay.status === 'CHECKED_OUT'
        ? t('departed')
        : stay.status === 'PENDING'
          ? t('pendingHold')
          : t('expected');

  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerDown={onPointerDown}
      title={`${stay.reservationCode} · ${stay.checkIn} → ${stay.checkOut}`}
      className={`absolute flex h-7 items-center overflow-hidden px-1.5 text-left text-xs font-medium ${
        onPointerDown ? 'cursor-grab active:cursor-grabbing' : ''
      } ${dragging ? 'opacity-50' : ''} ${
        bar.clippedStart
          ? 'rounded-l-none border-l-2 border-dashed border-current/40'
          : 'rounded-l-md'
      } ${bar.clippedEnd ? 'rounded-r-none' : 'rounded-r-md'} ${barTone(stay, today)}`}
      style={{
        left: `calc(var(--col) * ${String(bar.left)} + 1px)`,
        width: `calc(var(--col) * ${String(bar.width)} - 2px)`,
        top: `${String(bar.lane * LANE_PX + 4)}px`,
      }}
    >
      <span className="mr-1 flex shrink-0">
        <ChannelBadge
          source={stay.source}
          bookingSourceName={stay.bookingSourceName}
          channelType={stay.channelType}
        />
      </span>
      <span className="truncate">{name}</span>
      <span className="sr-only">
        {' '}
        · {status}
        {stay.upgraded ? ` · ${t('upgraded')}` : ''}
      </span>
    </button>
  );
}

function Legend() {
  const t = useTranslations('stayView');
  const channels: { source: string; name?: string; channel?: string }[] = [
    { source: 'OTA', name: 'Booking.com' },
    { source: 'OTA', name: 'Agoda' },
    { source: 'OTA', name: 'Expedia' },
    { source: 'DIRECT', channel: 'GOOGLE_HOTEL' },
    { source: 'DIRECT' },
    { source: 'WALK_IN' },
    { source: 'PHONE' },
    { source: 'EMAIL' },
    { source: 'TRAVEL_AGENT' },
  ];
  const items: [string, string][] = [
    ['bg-brand-100 ring-1 ring-brand-200', t('expected')],
    ['bg-emerald-200', t('inHouse')],
    ['bg-amber-200 ring-1 ring-amber-400', t('dueOut')],
    ['bg-sunk ring-1 ring-stone-200', t('departed')],
    ['bg-violet-100', t('upgraded')],
  ];
  return (
    <div className="space-y-1">
      <ul
        aria-label={t('legend')}
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500"
      >
        {items.map(([tone, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-3 w-5 rounded ${tone}`} />
            {label}
          </li>
        ))}
      </ul>
      <ul
        aria-label={t('channels')}
        className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500"
      >
        {channels.map((item) => (
          <li key={`${item.source}-${item.name ?? ''}-${item.channel ?? ''}`}>
            <ChannelBadgeWithLabel {...item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChannelBadgeWithLabel({
  source,
  name,
  channel,
}: {
  source: string;
  name?: string;
  channel?: string;
}) {
  const t = useTranslations('reservations');
  const key = badgeKeyFor({
    source,
    bookingSourceName: name ?? null,
    channelType: channel ?? null,
  });
  return (
    <span className="flex items-center gap-1">
      <ChannelBadge
        source={source}
        bookingSourceName={name ?? null}
        channelType={channel ?? null}
      />
      {name ?? t(`badge${key}`)}
    </span>
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
        free.find((room) => room.roomTypeId === stay.roomTypeId)?.roomId ?? free[0]?.roomId ?? '',
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
