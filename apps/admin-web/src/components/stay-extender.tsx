'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { ReservationDetail } from '@/lib/api';
import { extendStay } from '@/app/properties/[propertyId]/reservations/actions';
import { addDays, formatMoney } from '@/lib/dates';

type Stay = ReservationDetail['stays'][number];

/**
 * Keep a guest longer: push check-out later, nothing else.
 *
 * This is the only way to change a stay the guest has already started, and the
 * form says so rather than offering fields it would have to refuse. Moving the
 * arrival or the room type would mean giving back nights already slept in,
 * which the API will not do.
 */
export function StayExtender({
  propertyId,
  reservationId,
  version,
  stay,
}: {
  propertyId: string;
  reservationId: string;
  version: number;
  stay: Stay;
}) {
  const t = useTranslations('reservations');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [checkOut, setCheckOut] = useState(addDays(stay.checkOut, 1));
  const [reason, setReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setCheckOut(addDays(stay.checkOut, 1));
    setReason('');
    setError(null);
    setOpen(false);
  }

  function save() {
    setError(null);

    if (checkOut <= stay.checkOut) {
      setError(t('extendMustBeLater'));
      return;
    }

    startTransition(async () => {
      const result = await extendStay(propertyId, reservationId, stay.id, {
        version,
        checkOut,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });

      if (result.ok) {
        const added = result.extended?.addedAmount;
        setNotice(
          added ? t('extendDone', { amount: formatMoney(added.amount, added.currency) }) : null,
        );
        setOpen(false);
        router.refresh();
        return;
      }
      if (result.error?.code === 'VERSION_MISMATCH') {
        setError(t('staleData'));
        return;
      }
      // Everything else — a sold-out night, a missing price, the assigned room
      // taken by someone else — already arrives as a sentence a clerk can act
      // on, and naming the conflict is the whole value of it.
      setError(result.error?.message ?? null);
    });
  }

  if (!open) {
    return (
      <div className="mt-3">
        {notice && (
          <p className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {t('extendStay')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
      <p className="text-sm font-medium text-slate-900">{t('extendTitle')}</p>
      <p className="text-xs text-slate-500">{t('extendHint')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('extendNewCheckOut')}</span>
          <input
            type="date"
            value={checkOut}
            min={addDays(stay.checkOut, 1)}
            onChange={(event) => setCheckOut(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('modifyReason')}</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      {error && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? t('savingStay') : t('extendConfirm')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={reset}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {t('cancelEdit')}
        </button>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900';
