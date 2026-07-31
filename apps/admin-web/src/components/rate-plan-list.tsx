'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { RatePlan, RoomType } from '@/lib/api';
import { updateRatePlan } from '@/app/properties/[propertyId]/rate-plans/actions';
import { RatePlanForm } from './rate-plan-form';
import { RatePriceDialog } from './rate-price-dialog';
import { RateClearDialog } from './rate-clear-dialog';

export function RatePlanList({
  propertyId,
  ratePlans,
  roomTypes,
  currency,
  defaultFrom,
  defaultTo,
  canEdit,
}: {
  propertyId: string;
  ratePlans: RatePlan[];
  roomTypes: RoomType[];
  currency: string;
  defaultFrom: string;
  defaultTo: string;
  canEdit: boolean;
}) {
  const t = useTranslations('ratePlans');
  const meals = useTranslations('mealPlans');

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RatePlan | null>(null);
  const [pricing, setPricing] = useState<RatePlan | null>(null);
  const [clearing, setClearing] = useState<RatePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const roomTypeById = new Map(roomTypes.map((roomType) => [roomType.id, roomType]));

  function toggleSelling(ratePlan: RatePlan) {
    setError(null);
    startTransition(async () => {
      const result = await updateRatePlan(propertyId, ratePlan.id, {
        isActive: !ratePlan.isActive,
      });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  // A rate plan is always attached to a room type, so with none there is
  // nothing to attach one to. Point at the step that actually comes first.
  if (roomTypes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
        <p className="text-sm font-medium text-slate-700">{t('needRoomType')}</p>
        <Link
          href={`/properties/${propertyId}/room-types`}
          className="mt-4 inline-block rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('goToRoomTypes')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('add')}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {ratePlans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-700">{t('empty')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                <th className="px-3 py-2 font-medium">{t('code')}</th>
                <th className="px-3 py-2 font-medium">{t('name')}</th>
                <th className="px-3 py-2 font-medium">{t('roomType')}</th>
                <th className="px-3 py-2 font-medium">{t('mealPlan')}</th>
                <th className="px-3 py-2 font-medium">{t('refundable')}</th>
                <th className="px-3 py-2 font-medium">{t('active')}</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {ratePlans.map((ratePlan) => {
                const roomType = roomTypeById.get(ratePlan.roomTypeId);
                return (
                  <tr
                    key={ratePlan.id}
                    className={`border-b border-slate-100 last:border-0 ${
                      ratePlan.isActive ? '' : 'bg-slate-50/60 text-slate-400'
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{ratePlan.code}</td>
                    <td className="px-3 py-2 font-medium text-slate-800">{ratePlan.name}</td>
                    <td className="px-3 py-2 text-slate-600">{roomType?.name ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{meals(ratePlan.mealPlan)}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {ratePlan.isRefundable ? t('refundable') : t('nonRefundable')}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          ratePlan.isActive
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {ratePlan.isActive ? t('active') : t('inactive')}
                      </span>
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            disabled={!roomType}
                            onClick={() => setPricing(ratePlan)}
                            className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                          >
                            {t('setPrices')}
                          </button>
                          {/*
                            Removing a price is destructive in a way setting one
                            is not — the night comes off sale entirely — so it
                            reads as a separate, quieter action, not a variant of
                            "Set prices".
                          */}
                          <button
                            type="button"
                            disabled={!roomType}
                            onClick={() => setClearing(ratePlan)}
                            className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            {t('clearPrices')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(ratePlan)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            {t('edit')}
                          </button>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => toggleSelling(ratePlan)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          >
                            {ratePlan.isActive ? t('deactivate') : t('activate')}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && ratePlans.length > 0 && <p className="text-xs text-slate-400">{t('noDelete')}</p>}

      {creating && (
        <RatePlanForm
          propertyId={propertyId}
          roomTypes={roomTypes}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <RatePlanForm
          propertyId={propertyId}
          roomTypes={roomTypes}
          ratePlan={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {pricing && roomTypeById.get(pricing.roomTypeId) && (
        <RatePriceDialog
          propertyId={propertyId}
          ratePlan={pricing}
          roomType={roomTypeById.get(pricing.roomTypeId)!}
          currency={currency}
          defaultFrom={defaultFrom}
          defaultTo={defaultTo}
          onClose={() => setPricing(null)}
        />
      )}
      {clearing && roomTypeById.get(clearing.roomTypeId) && (
        <RateClearDialog
          propertyId={propertyId}
          ratePlan={clearing}
          roomType={roomTypeById.get(clearing.roomTypeId)!}
          defaultFrom={defaultFrom}
          defaultTo={defaultTo}
          onClose={() => setClearing(null)}
        />
      )}
    </div>
  );
}
