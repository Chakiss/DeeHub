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
  /**
   * Plans that can be a parent: active, and holding their own prices.
   *
   * Filtered here rather than in the API because it is a UI affordance — the
   * server refuses the same cases with a message, which is what actually
   * enforces them.
   */
  parentCandidates: RatePlan[];
  onClose: () => void;
}

export function RatePlanForm({
  propertyId,
  roomTypes,
  ratePlan,
  parentCandidates,
  onClose,
}: Props) {
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

  /*
   * Whether a plan is derived is fixed at creation: switching either way would
   * strand its stored prices or leave it with none. So the toggle only exists
   * while creating, and editing shows the offset alone.
   */
  const [derived, setDerived] = useState(ratePlan?.parentRatePlanId !== null && editing);
  const [parentId, setParentId] = useState(ratePlan?.parentRatePlanId ?? '');
  const [derivationType, setDerivationType] = useState<'PERCENTAGE' | 'AMOUNT'>(
    ratePlan?.derivationType ?? 'PERCENTAGE',
  );
  // Shown in percent or in whole currency, stored in basis points or minor
  // units — the same conversion the folio does for amounts.
  const [offset, setOffset] = useState(
    ratePlan?.derivationValue !== null && ratePlan?.derivationValue !== undefined
      ? String(ratePlan.derivationValue / 100)
      : '-10',
  );

  const eligibleParents = parentCandidates.filter(
    (candidate) => candidate.roomTypeId === roomTypeId && candidate.id !== ratePlan?.id,
  );

  /*
   * The <select> shows only plans on the CHOSEN room type, and the chosen
   * parent has to be one of them. Holding the raw state instead let the room
   * type change out from under it: the dropdown listed the right options while
   * `parentId` still pointed at a plan on another room type, and the server —
   * correctly — refused. Deriving it from the visible list is what makes the
   * two agree, without an effect that fights the user's own selection.
   */
  const selectedParent =
    eligibleParents.find((candidate) => candidate.id === parentId)?.id ??
    eligibleParents[0]?.id ??
    '';

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const offsetValue = Math.round(Number(offset) * 100);
    if (derived && (!Number.isFinite(offsetValue) || offsetValue === 0)) {
      setSaving(false);
      setError(t('offsetRequired'));
      return;
    }

    const result = editing
      ? await updateRatePlan(propertyId, ratePlan.id, {
          name,
          mealPlan,
          isRefundable,
          ...(ratePlan.derivationType ? { derivationValue: offsetValue } : {}),
        })
      : await createRatePlan(propertyId, {
          roomTypeId,
          code,
          name,
          mealPlan,
          isRefundable,
          // selectedParent, never the raw state: `parentId` stays empty until
          // somebody actually changes the dropdown, and the dropdown SHOWS the
          // derived default. Reading the state here silently created a base
          // plan while the form said otherwise.
          ...(derived && selectedParent
            ? {
                derivation: {
                  parentRatePlanId: selectedParent,
                  type: derivationType,
                  value: offsetValue,
                },
              }
            : {}),
        });

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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:items-center"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-2xl bg-white shadow-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-ink-900">{editing ? t('edit') : t('add')}</h2>

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
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk disabled:text-stone-500"
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
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm uppercase outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk disabled:text-stone-500"
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
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="Best Available Rate"
            />
          </Field>
        </div>

        <Field id="rp-meal" label={t('mealPlan')}>
          <select
            id="rp-meal"
            value={mealPlan}
            onChange={(event) => setMealPlan(event.target.value as MealPlan)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {MEAL_PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {meals(plan)}
              </option>
            ))}
          </select>
        </Field>

        {!editing && eligibleParents.length > 0 && (
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={derived}
              onChange={(event) => setDerived(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-stone-300"
            />
            <span>
              {t('derivedLabel')}
              <span className="block text-xs text-stone-400">{t('derivedHint')}</span>
            </span>
          </label>
        )}

        {(derived || (editing && ratePlan.derivationType)) && (
          <div className="grid gap-4 rounded-lg border border-stone-200 bg-sunk p-3 sm:grid-cols-3">
            <Field id="rp-parent" label={t('parentPlan')}>
              <select
                id="rp-parent"
                value={editing ? (ratePlan.parentRatePlanId ?? '') : selectedParent}
                onChange={(event) => setParentId(event.target.value)}
                // The parent is fixed after creation for the same reason the
                // room type is: the prices already quoted came from it.
                disabled={editing}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-sunk disabled:text-stone-500"
              >
                {eligibleParents.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
                {editing && ratePlan.parentRatePlanId && eligibleParents.length === 0 && (
                  <option value={ratePlan.parentRatePlanId}>{t('parentPlan')}</option>
                )}
              </select>
            </Field>

            <Field id="rp-derivation-type" label={t('offsetType')}>
              <select
                id="rp-derivation-type"
                value={derivationType}
                onChange={(event) =>
                  setDerivationType(event.target.value as 'PERCENTAGE' | 'AMOUNT')
                }
                disabled={editing}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-sunk disabled:text-stone-500"
              >
                <option value="PERCENTAGE">{t('offsetPercent')}</option>
                <option value="AMOUNT">{t('offsetAmount')}</option>
              </select>
            </Field>

            <Field id="rp-offset" label={t('offset')} hint={t('offsetHint')}>
              <input
                id="rp-offset"
                inputMode="decimal"
                value={offset}
                onChange={(event) => setOffset(event.target.value)}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                placeholder="-10"
              />
            </Field>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={isRefundable}
            onChange={(event) => setRefundable(event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('refundable')}
        </label>

        {/* Said up front rather than discovered as a missing option. */}

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
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-stone-400">
          {hint}
        </span>
      )}
    </div>
  );
}
