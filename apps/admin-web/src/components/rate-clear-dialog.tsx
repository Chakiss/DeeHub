'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { deleteRates } from '@/app/properties/[propertyId]/rate-plans/actions';
import type { RatePlan, RoomType } from '@/lib/api';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/**
 * Remove nightly prices that were entered by mistake.
 *
 * Separate from `RatePriceDialog` on purpose. Setting a price and un-setting it
 * are not the same act: a night with no price cannot be booked at all, so this
 * takes rooms OFF SALE and has to say so before and after. Folding it into the
 * pricing form as "leave the field blank" would make an accidental deletion
 * indistinguishable from an untouched field.
 */
export function RateClearDialog({
  propertyId,
  ratePlan,
  roomType,
  defaultFrom,
  defaultTo,
  onClose,
}: {
  propertyId: string;
  ratePlan: RatePlan;
  roomType: RoomType;
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
}) {
  const t = useTranslations('ratePlans');
  const router = useRouter();

  const occupancies = Array.from({ length: roomType.maxOccupancy }, (_, index) => index + 1);

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [days, setDays] = useState<string[]>([]);
  const [chosenOccupancies, setChosenOccupancies] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ removed: number; unsellable: number } | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (to <= from) {
      setError(t('rangeInvalid'));
      return;
    }

    setBusy(true);
    const response = await deleteRates(propertyId, [
      {
        ratePlanId: ratePlan.id,
        from,
        to,
        ...(days.length > 0 ? { daysOfWeek: days } : {}),
        // Absent means every occupancy, which is what "none selected" means here.
        ...(chosenOccupancies.length > 0 ? { occupancies: chosenOccupancies } : {}),
      },
    ]);
    setBusy(false);

    if (!response.ok) {
      setError(response.error?.message ?? t('clearFailed'));
      return;
    }

    /*
     * The dialog stays open on success rather than closing.
     *
     * How many nights just went off sale is the one thing the manager needs to
     * read, and a dialog that vanishes takes that number with it.
     */
    setResult({
      removed: response.pricesRemoved ?? 0,
      unsellable: response.nightsNowUnsellable ?? 0,
    });
    router.refresh();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('clearPricesFor', { name: ratePlan.name })}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 sm:items-center"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div>
          <h2 className="text-lg font-medium text-slate-900">
            {t('clearPricesFor', { name: ratePlan.name })}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{t('clearExplain')}</p>
        </div>

        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          {t('clearZeroWarning')}
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="clear-from" className="mb-1 block text-sm font-medium text-slate-700">
              {t('from')}
            </label>
            <input
              id="clear-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div>
            <label htmlFor="clear-to" className="mb-1 block text-sm font-medium text-slate-700">
              {t('to')}
            </label>
            <input
              id="clear-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
        </div>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">{t('weekdays')}</legend>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => setDays((current) => toggle(current, day as string))}
                aria-pressed={days.includes(day)}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  days.includes(day)
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {day}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{t('weekdaysHint')}</p>
        </fieldset>

        {/*
          The usual slip is pricing the wrong occupancy, not the wrong dates,
          so removing one occupancy has to be possible without touching the rest.
        */}
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">
            {t('clearOccupancies')}
          </legend>
          <div className="flex flex-wrap gap-1">
            {occupancies.map((occupancy) => (
              <button
                key={occupancy}
                type="button"
                onClick={() => setChosenOccupancies((current) => toggle(current, occupancy))}
                aria-pressed={chosenOccupancies.includes(occupancy)}
                className={`rounded-md border px-2 py-1 text-xs font-medium tabular-nums ${
                  chosenOccupancies.includes(occupancy)
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {occupancy === 1 ? t('guest') : t('guests', { count: occupancy })}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{t('clearOccupanciesHint')}</p>
        </fieldset>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {result && (
          <div
            role="status"
            className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200"
          >
            <p className="text-slate-800">
              {result.removed === 0 ? t('clearNothing') : t('clearDone', { count: result.removed })}
            </p>
            {result.removed > 0 && (
              <p className={result.unsellable > 0 ? 'text-amber-800' : 'text-slate-500'}>
                {result.unsellable > 0
                  ? t('clearUnsellable', { count: result.unsellable })
                  : t('clearUnsellableNone')}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {result ? t('done') : t('cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? t('clearing') : t('clearConfirm')}
          </button>
        </div>
      </form>
    </div>
  );
}
