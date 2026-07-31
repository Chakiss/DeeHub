'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { CreateReservationInput, InventoryGrid, RatePlan, RoomType } from '@/lib/api';
import {
  checkAvailability,
  createReservation,
} from '@/app/properties/[propertyId]/reservations/actions';
import { formatMoney } from '@/lib/dates';

const SOURCES = ['WALK_IN', 'PHONE', 'EMAIL', 'DIRECT'] as const;

interface StayDraft {
  key: string;
  roomTypeId: string;
  ratePlanId: string;
  adults: number;
  children: number;
  guestName: string;
}

/**
 * Taking a booking by hand.
 *
 * Deliberately dates-first: the desk is asked what nights, then shown what is
 * sellable across exactly those nights, then asked for the guest. The
 * competitor's form asks for the guest first and only discovers the hotel is
 * full at the end.
 *
 * The availability panel takes NO hold — see `checkAvailability`. The API
 * decides at save time, inside the transaction that writes the booking.
 */
export function BookingForm({
  propertyId,
  currency,
  today,
  roomTypes,
  ratePlans,
}: {
  propertyId: string;
  currency: string;
  today: string;
  roomTypes: RoomType[];
  ratePlans: RatePlan[];
}) {
  const t = useTranslations('reservations');
  const router = useRouter();

  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(addDays(today, 1));

  const plansFor = useMemo(() => {
    const map = new Map<string, RatePlan[]>();
    for (const plan of ratePlans) {
      if (!plan.isActive) continue;
      const list = map.get(plan.roomTypeId) ?? [];
      list.push(plan);
      map.set(plan.roomTypeId, list);
    }
    return map;
  }, [ratePlans]);

  const [stays, setStays] = useState<StayDraft[]>(() => [newStay(roomTypes, plansFor)]);
  const [booker, setBooker] = useState({ name: '', email: '', phone: '' });
  const [source, setSource] = useState<(typeof SOURCES)[number]>('WALK_IN');
  const [specialRequests, setSpecialRequests] = useState('');

  const [grid, setGrid] = useState<InventoryGrid | null>(null);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const datesValid = Boolean(checkIn && checkOut && checkOut > checkIn);
  const nights = datesValid ? countNights(checkIn, checkOut) : 0;

  // Re-read availability whenever the window moves. The grid covers exactly the
  // requested nights, so "2 left" means 2 on every night — not on the best one.
  useEffect(() => {
    if (!datesValid) {
      setGrid(null);
      return;
    }
    let cancelled = false;
    setLoadingGrid(true);
    void checkAvailability(propertyId, checkIn, checkOut).then((result) => {
      if (cancelled) return;
      setLoadingGrid(false);
      setGrid(result.ok && result.grid ? result.grid : null);
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, checkIn, checkOut, datesValid]);

  /**
   * Worst night wins. A stay spans every night it covers, so a room type with
   * five free nights and one sold-out night cannot take the booking.
   */
  const availability = useMemo(() => {
    const map = new Map<
      string,
      { available: number; closed: boolean; lowestRate: number | null }
    >();
    if (!grid) return map;
    for (const row of grid.roomTypes) {
      // The grid range is half-open, so every day it returns is a night slept —
      // the check-out date is already excluded and must not be counted or priced.
      const stayNights = row.days;
      if (stayNights.length === 0) continue;
      map.set(row.roomTypeId, {
        available: Math.min(...stayNights.map((day) => day.available)),
        closed: stayNights.some((day) => !day.open),
        // Only a total when every night has a price. A stay with one unpriced
        // night cannot be sold at all, so a partial sum would be a lie.
        lowestRate: stayNights.every((day) => day.rate)
          ? stayNights.reduce((sum, day) => sum + (day.rate?.amountMinor ?? 0), 0)
          : null,
      });
    }
    return map;
  }, [grid]);

  function updateStay(key: string, patch: Partial<StayDraft>) {
    setStays((current) =>
      current.map((stay) => {
        if (stay.key !== key) return stay;
        const next = { ...stay, ...patch };
        // Changing the room type invalidates the plan: plans belong to a type.
        if (patch.roomTypeId && patch.roomTypeId !== stay.roomTypeId) {
          next.ratePlanId = plansFor.get(patch.roomTypeId)?.[0]?.id ?? '';
        }
        return next;
      }),
    );
  }

  function submit() {
    setError(null);
    if (!datesValid) {
      setError(checkIn && checkOut ? t('checkOutAfterCheckIn') : t('requiredDates'));
      return;
    }
    if (!booker.name.trim()) {
      setError(t('requiredBooker'));
      return;
    }
    if (stays.some((stay) => !stay.ratePlanId || !stay.roomTypeId)) {
      setError(t('requiredRatePlan'));
      return;
    }

    const input: CreateReservationInput = {
      source,
      status: 'CONFIRMED',
      booker: {
        name: booker.name.trim(),
        ...(booker.email.trim() ? { email: booker.email.trim() } : {}),
        ...(booker.phone.trim() ? { phone: booker.phone.trim() } : {}),
      },
      stays: stays.map((stay) => ({
        roomTypeId: stay.roomTypeId,
        ratePlanId: stay.ratePlanId,
        checkIn,
        checkOut,
        adults: stay.adults,
        ...(stay.children > 0 ? { children: stay.children } : {}),
        ...(stay.guestName.trim() ? { guestName: stay.guestName.trim() } : {}),
      })),
      ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}),
    };

    startTransition(async () => {
      const result = await createReservation(propertyId, input);
      if (result.ok && result.reservation) {
        router.push(`/properties/${propertyId}/reservations/${result.reservation.id}`);
        return;
      }
      // Sold out, closed to arrival, no price for a night: the API's message
      // names the actual reason, and rewording it here would lose that.
      setError(result.error?.message ?? null);
    });
  }

  if (roomTypes.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="font-medium text-slate-900">{t('noRoomTypes')}</p>
        <p className="mt-1 text-sm text-slate-500">{t('noRoomTypesHint')}</p>
        <a
          href={`/properties/${propertyId}/room-types`}
          className="mt-4 inline-block rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          {t('goToRoomTypes')}
        </a>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card title={t('datesHeading')}>
          <div className="flex flex-wrap items-end gap-4">
            <Labelled label={t('checkIn')}>
              <input
                type="date"
                value={checkIn}
                onChange={(event) => {
                  const next = event.target.value;
                  setCheckIn(next);
                  // Keep the window valid rather than showing an error the user
                  // did not cause by dragging one end past the other.
                  if (next && checkOut <= next) setCheckOut(addDays(next, 1));
                }}
                className={inputClass}
              />
            </Labelled>
            <Labelled label={t('checkOut')}>
              <input
                type="date"
                value={checkOut}
                min={addDays(checkIn, 1)}
                onChange={(event) => setCheckOut(event.target.value)}
                className={inputClass}
              />
            </Labelled>
            {nights > 0 && (
              <span className="pb-1.5 text-sm text-slate-500">
                {t('nightCount', { count: nights })}
              </span>
            )}
          </div>
        </Card>

        <Card title={t('roomsHeading')}>
          <ul className="space-y-3">
            {stays.map((stay, index) => {
              const plans = plansFor.get(stay.roomTypeId) ?? [];
              const roomType = roomTypes.find((candidate) => candidate.id === stay.roomTypeId);
              return (
                <li key={stay.key} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      {t('roomLabel', { index: index + 1 })}
                    </span>
                    {stays.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setStays((current) => current.filter((item) => item.key !== stay.key))
                        }
                        className="text-xs text-rose-600 hover:underline"
                      >
                        {t('removeRoom')}
                      </button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Labelled label={t('roomType')}>
                      <select
                        value={stay.roomTypeId}
                        onChange={(event) =>
                          updateStay(stay.key, { roomTypeId: event.target.value })
                        }
                        className={inputClass}
                      >
                        {roomTypes.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                      </select>
                    </Labelled>
                    <Labelled label={t('ratePlan')}>
                      {plans.length === 0 ? (
                        <p className="py-1.5 text-sm text-rose-600">{t('noRatePlan')}</p>
                      ) : (
                        <select
                          value={stay.ratePlanId}
                          onChange={(event) =>
                            updateStay(stay.key, { ratePlanId: event.target.value })
                          }
                          className={inputClass}
                        >
                          {plans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Labelled>
                    <div className="flex gap-3">
                      <Labelled label={t('adults')}>
                        <input
                          type="number"
                          min={1}
                          max={roomType?.maxAdults ?? 20}
                          value={stay.adults}
                          onChange={(event) =>
                            updateStay(stay.key, { adults: Number(event.target.value) || 1 })
                          }
                          className={`${inputClass} w-20`}
                        />
                      </Labelled>
                      <Labelled label={t('children')}>
                        <input
                          type="number"
                          min={0}
                          max={roomType?.maxChildren ?? 20}
                          value={stay.children}
                          onChange={(event) =>
                            updateStay(stay.key, { children: Number(event.target.value) || 0 })
                          }
                          className={`${inputClass} w-20`}
                        />
                      </Labelled>
                    </div>
                    <Labelled label={t('guestNameOptional')}>
                      <input
                        type="text"
                        value={stay.guestName}
                        onChange={(event) =>
                          updateStay(stay.key, { guestName: event.target.value })
                        }
                        className={inputClass}
                      />
                    </Labelled>
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => setStays((current) => [...current, newStay(roomTypes, plansFor)])}
            className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            {t('addRoom')}
          </button>
        </Card>

        <Card title={t('bookerHeading')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label={t('bookerName')}>
              <input
                type="text"
                value={booker.name}
                onChange={(event) => setBooker({ ...booker, name: event.target.value })}
                className={inputClass}
              />
            </Labelled>
            <Labelled label={t('sourceLabel')}>
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as (typeof SOURCES)[number])}
                className={inputClass}
              >
                {SOURCES.map((option) => (
                  <option key={option} value={option}>
                    {t(`source${option}`)}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label={t('bookerEmail')}>
              <input
                type="email"
                value={booker.email}
                onChange={(event) => setBooker({ ...booker, email: event.target.value })}
                className={inputClass}
              />
            </Labelled>
            <Labelled label={t('bookerPhone')}>
              <input
                type="tel"
                value={booker.phone}
                onChange={(event) => setBooker({ ...booker, phone: event.target.value })}
                className={inputClass}
              />
            </Labelled>
          </div>
          <div className="mt-3">
            <Labelled label={t('specialRequestsOptional')}>
              <textarea
                rows={2}
                value={specialRequests}
                onChange={(event) => setSpecialRequests(event.target.value)}
                className={inputClass}
              />
            </Labelled>
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        <Card title={t('availabilityHeading')}>
          {loadingGrid && <p className="text-sm text-slate-500">{t('checkingAvailability')}</p>}
          {!loadingGrid && (
            <ul className="space-y-2">
              {roomTypes.map((roomType) => {
                const state = availability.get(roomType.id);
                return (
                  <li key={roomType.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-slate-700">{roomType.name}</span>
                    <span className="text-right">
                      <span
                        className={`block text-sm font-medium ${
                          !state || state.closed || state.available <= 0
                            ? 'text-rose-600'
                            : 'text-emerald-700'
                        }`}
                      >
                        {!state
                          ? '—'
                          : state.closed
                            ? t('closed')
                            : state.available <= 0
                              ? t('soldOut')
                              : t('availableCount', { count: state.available })}
                      </span>
                      <span className="tabular block text-xs text-slate-500">
                        {state?.lowestRate == null
                          ? t('noRate')
                          : t('fromPrice', { price: formatMoney(state.lowestRate, currency) })}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">{t('availabilityHint')}</p>
        </Card>

        <div className="space-y-2">
          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {pending ? t('saving') : t('save')}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => router.push(`/properties/${propertyId}/reservations`)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {t('discard')}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900';

function newStay(roomTypes: RoomType[], plansFor: Map<string, RatePlan[]>): StayDraft {
  const roomType = roomTypes[0];
  return {
    key: crypto.randomUUID(),
    roomTypeId: roomType?.id ?? '',
    ratePlanId: roomType ? (plansFor.get(roomType.id)?.[0]?.id ?? '') : '',
    adults: roomType?.standardOccupancy ?? 2,
    children: 0,
    guestName: '',
  };
}

/** Calendar arithmetic in UTC: these are business dates, not instants. */
function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function countNights(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      {children}
    </label>
  );
}
