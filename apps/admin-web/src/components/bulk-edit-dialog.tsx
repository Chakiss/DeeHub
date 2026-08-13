'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { updateInventory } from '@/app/properties/[propertyId]/inventory/actions';
import type { InventoryUpdate } from '@/lib/api';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

export function BulkEditDialog({
  propertyId,
  roomTypes,
  defaultFrom,
  defaultTo,
  onClose,
}: {
  propertyId: string;
  roomTypes: { id: string; name: string }[];
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
}) {
  const t = useTranslations('inventory');
  const router = useRouter();

  const [roomTypeId, setRoomTypeId] = useState(roomTypes[0]?.id ?? '');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [days, setDays] = useState<string[]>([]);
  const [allotment, setAllotment] = useState('');
  const [minStay, setMinStay] = useState('');
  const [stopSell, setStopSell] = useState<'' | 'true' | 'false'>('');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setConflicts([]);

    const update: InventoryUpdate = {
      roomTypeId,
      from,
      to,
      ...(days.length > 0 ? { daysOfWeek: days } : {}),
      ...(allotment === '' ? {} : { allotment: Number(allotment) }),
      ...(minStay === '' ? {} : { minStay: Number(minStay) }),
      ...(stopSell === '' ? {} : { stopSell: stopSell === 'true' }),
    };

    // Every optional field left blank means "leave unchanged", so an empty form
    // would be a no-op the API rightly rejects. Say so before the round trip.
    const changesSomething =
      update.allotment !== undefined ||
      update.minStay !== undefined ||
      update.stopSell !== undefined;
    if (!changesSomething) {
      setError(t('leaveUnchanged'));
      return;
    }

    setBusy(true);
    try {
      const result = await updateInventory(propertyId, [update]);
      if (result.ok) {
        router.refresh();
        onClose();
        return;
      }

      setError(result.error?.message ?? 'Update failed');
      // The API names every date that blocked the edit; showing them is the
      // difference between "it failed" and "move these two bookings first".
      const blocked = result.error?.details?.['conflicts'];
      if (Array.isArray(blocked)) {
        setConflicts(
          blocked.map((entry) => {
            const row = entry as { date?: string; booked?: number };
            return `${String(row.date)} — ${String(row.booked)} sold`;
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-medium text-ink-900">{t('editTitle')}</h2>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">{t('roomType')}</span>
          <select
            value={roomTypeId}
            onChange={(event) => setRoomTypeId(event.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            {roomTypes.map((roomType) => (
              <option key={roomType.id} value={roomType.id}>
                {roomType.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">{t('from')}</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              required
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">{t('to')}</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              required
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-700">{t('weekdays')}</legend>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((day) => {
              const active = days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setDays((current) =>
                      active ? current.filter((entry) => entry !== day) : [...current, day],
                    )
                  }
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                    active
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-stone-300 bg-white text-stone-600 hover:bg-sunk/70'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">{t('allotment')}</span>
            <input
              type="number"
              min={0}
              value={allotment}
              onChange={(event) => setAllotment(event.target.value)}
              placeholder="—"
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">{t('minStay')}</span>
            <input
              type="number"
              min={1}
              value={minStay}
              onChange={(event) => setMinStay(event.target.value)}
              placeholder="—"
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">{t('stopSell')}</span>
            <select
              value={stopSell}
              onChange={(event) => setStopSell(event.target.value as '' | 'true' | 'false')}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="">—</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
        </div>

        <p className="text-xs text-stone-400">{t('leaveUnchanged')}</p>

        {error && (
          <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            <p>{error}</p>
            {conflicts.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-xs">
                {conflicts.map((conflict) => (
                  <li key={conflict}>{conflict}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? t('applying') : t('apply')}
          </button>
        </div>
      </form>
    </div>
  );
}
