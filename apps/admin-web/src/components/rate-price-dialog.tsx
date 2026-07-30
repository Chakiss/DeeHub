'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { updateRates } from '@/app/properties/[propertyId]/rate-plans/actions';
import type { RatePlan, RoomType } from '@/lib/api';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/**
 * Set nightly prices for one rate plan.
 *
 * A price is per occupancy, not per room: a booking is quoted by how many
 * guests it is for, so every occupancy a hotel sells needs its own figure.
 * The inputs run 1..maxOccupancy of the plan's room type, because that is
 * exactly the range a guest can select.
 */
export function RatePriceDialog({
  propertyId,
  ratePlan,
  roomType,
  currency,
  defaultFrom,
  defaultTo,
  onClose,
}: {
  propertyId: string;
  ratePlan: RatePlan;
  roomType: RoomType;
  currency: string;
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
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleDay(day: string) {
    setDays((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day],
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (to <= from) {
      setError(t('rangeInvalid'));
      return;
    }

    // Major units in the field, minor units on the wire (ADR-0003). Rounded
    // rather than truncated so 1234.565 does not quietly lose a satang.
    const prices = occupancies
      .filter((occupancy) => (amounts[occupancy] ?? '').trim() !== '')
      .map((occupancy) => ({
        occupancy,
        amount: Math.round(Number(amounts[occupancy]) * 100),
      }))
      .filter((price) => Number.isFinite(price.amount) && price.amount >= 0);

    if (prices.length === 0) {
      setError(t('priceRequired'));
      return;
    }

    setBusy(true);
    const result = await updateRates(propertyId, [
      {
        ratePlanId: ratePlan.id,
        from,
        to,
        ...(days.length > 0 ? { daysOfWeek: days } : {}),
        prices,
      },
    ]);
    setBusy(false);

    if (!result.ok) {
      setError(result.error?.message ?? t('failed'));
      return;
    }

    router.refresh();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('pricesFor', { name: ratePlan.name })}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 sm:items-center"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-slate-900">
          {t('pricesFor', { name: ratePlan.name })}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="rate-from" className="mb-1 block text-sm font-medium text-slate-700">
              {t('from')}
            </label>
            <input
              id="rate-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div>
            <label htmlFor="rate-to" className="mb-1 block text-sm font-medium text-slate-700">
              {t('to')}
            </label>
            <input
              id="rate-to"
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
                onClick={() => toggleDay(day)}
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

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">
            {t('occupancyPrices')}
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {occupancies.map((occupancy) => (
              <div key={occupancy}>
                <label
                  htmlFor={`rate-occ-${String(occupancy)}`}
                  className="mb-1 block text-xs text-slate-500"
                >
                  {occupancy === 1 ? t('guest') : t('guests', { count: occupancy })}
                </label>
                <input
                  id={`rate-occ-${String(occupancy)}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={amounts[occupancy] ?? ''}
                  onChange={(event) =>
                    setAmounts((current) => ({ ...current, [occupancy]: event.target.value }))
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">{t('occupancyHint', { currency })}</p>
        </fieldset>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? t('applying') : t('apply')}
          </button>
        </div>
      </form>
    </div>
  );
}
