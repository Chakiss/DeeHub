'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import type { RatePlan, RoomType } from '@/lib/api';
import { MEAL_PLANS, type MealPlan } from '@/lib/meal-plans';
import { createRatePlan, updateRatePlan } from '@/app/properties/[propertyId]/rate-plans/actions';

interface Props {
  propertyId: string;
  roomTypes: RoomType[];
  /** Absent when creating; present when editing, where code and room type lock. */
  ratePlan?: RatePlan;
  onClose: () => void;
}

export function RatePlanForm({ propertyId, roomTypes, ratePlan, onClose }: Props) {
  const t = useTranslations('ratePlans');
  const meals = useTranslations('mealPlans');
  const editing = ratePlan !== undefined;

  const [roomTypeId, setRoomTypeId] = useState(ratePlan?.roomTypeId ?? roomTypes[0]?.id ?? '');
  const [code, setCode] = useState(ratePlan?.code ?? '');
  const [name, setName] = useState(ratePlan?.name ?? '');
  const [mealPlan, setMealPlan] = useState<MealPlan>(
    (ratePlan?.mealPlan as MealPlan | undefined) ?? 'ROOM_ONLY',
  );
  const [isRefundable, setRefundable] = useState(ratePlan?.isRefundable ?? true);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const result = editing
      ? await updateRatePlan(propertyId, ratePlan.id, { name, mealPlan, isRefundable })
      : await createRatePlan(propertyId, { roomTypeId, code, name, mealPlan, isRefundable });

    setSaving(false);

    if (!result.ok) {
      setError(
        result.error?.code === 'CONFLICT' ? t('codeTaken') : (result.error?.message ?? t('failed')),
      );
      return;
    }

    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? t('edit') : t('add')}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 sm:items-center"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-slate-900">{editing ? t('edit') : t('add')}</h2>

        <Field
          id="rp-room-type"
          label={t('roomType')}
          hint={editing ? t('roomTypeHint') : undefined}
        >
          <select
            id="rp-room-type"
            value={roomTypeId}
            onChange={(event) => setRoomTypeId(event.target.value)}
            // Fixed after creation: every already-priced night and every past
            // booking was sold under this room type.
            disabled={editing}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-500"
          >
            {roomTypes.map((roomType) => (
              <option key={roomType.id} value={roomType.id}>
                {roomType.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rp-code" label={t('code')} hint={editing ? undefined : t('codeHint')}>
            <input
              id="rp-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={editing}
              required
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm uppercase outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-500"
              placeholder="BAR"
            />
          </Field>

          <Field id="rp-name" label={t('name')}>
            <input
              id="rp-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="Best Available Rate"
            />
          </Field>
        </div>

        <Field id="rp-meal" label={t('mealPlan')}>
          <select
            id="rp-meal"
            value={mealPlan}
            onChange={(event) => setMealPlan(event.target.value as MealPlan)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {MEAL_PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {meals(plan)}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isRefundable}
            onChange={(event) => setRefundable(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {t('refundable')}
        </label>

        {/* Said up front rather than discovered as a missing option. */}
        {!editing && <p className="text-xs text-slate-400">{t('noDerived')}</p>}

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

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-slate-400">
          {hint}
        </span>
      )}
    </div>
  );
}
