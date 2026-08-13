'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { ReservationDetail } from '@/lib/api';
import { extendStay, shortenStay } from '@/app/properties/[propertyId]/reservations/actions';
import { addDays, formatMoney } from '@/lib/dates';

type Stay = ReservationDetail['stays'][number];

/**
 * When is this guest actually leaving?
 *
 * One control for both directions, because that is one question at the desk.
 * The API keeps extending and shortening apart — they do opposite things to
 * inventory, and only one of them can be refused for a room clash — but making
 * a clerk pick the right verb before they can type a date would be the API's
 * shape leaking onto the screen.
 *
 * It is the only way to change a stay the guest has already started, and the
 * form says so rather than offering fields it would have to refuse. Moving the
 * arrival or the room type would mean giving back nights already slept in.
 */
export function StayDeparture({
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
  const [checkOut, setCheckOut] = useState(stay.checkOut);
  const [reason, setReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setCheckOut(stay.checkOut);
    setReason('');
    setError(null);
    setOpen(false);
  }

  function save() {
    setError(null);

    if (checkOut === stay.checkOut) {
      setError(t('departureUnchanged'));
      return;
    }
    const input = {
      version,
      checkOut,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };

    startTransition(async () => {
      const result =
        checkOut > stay.checkOut
          ? await extendStay(propertyId, reservationId, stay.id, input)
          : await shortenStay(propertyId, reservationId, stay.id, input);

      if (result.ok) {
        setNotice(describe(result));
        setOpen(false);
        router.refresh();
        return;
      }
      if (result.error?.code === 'VERSION_MISMATCH') {
        setError(t('staleData'));
        return;
      }
      // Everything else — a sold-out night, a missing price, the assigned room
      // taken by someone else, a date already slept through — already arrives
      // as a sentence a clerk can act on, and naming the cause is its value.
      setError(result.error?.message ?? null);
    });
  }

  function describe(result: Awaited<ReturnType<typeof extendStay | typeof shortenStay>>): string {
    if ('extended' in result && result.extended) {
      const { amount, currency } = result.extended.addedAmount;
      return t('extendDone', { amount: formatMoney(amount, currency) });
    }
    if ('shortened' in result && result.shortened) {
      const { amount, currency } = result.shortened.refundedAmount;
      // Says what came OFF the bill, and — because a hotelier will assume
      // otherwise — that nothing was charged for leaving early.
      return t('shortenDone', {
        amount: formatMoney(amount, currency),
        nights: result.shortened.releasedNights.length,
      });
    }
    return '';
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
          className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-ink-700 hover:bg-sunk/70"
        >
          {t('changeDeparture')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-stone-300 bg-sunk p-3">
      <p className="text-sm font-medium text-ink-900">{t('departureTitle')}</p>
      <p className="text-xs text-stone-500">{t('departureHint')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">{t('departureNewCheckOut')}</span>
          <input
            type="date"
            value={checkOut}
            // A stay must keep at least one night; cutting it to nothing is a
            // cancellation, which the API refuses and this does not offer.
            min={addDays(stay.checkIn, 1)}
            onChange={(event) => setCheckOut(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">{t('modifyReason')}</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      {/* Named before it happens, because the two directions cost the hotel
          opposite things and the button says neither. */}
      {checkOut !== stay.checkOut && (
        <p className="text-xs text-stone-600">
          {checkOut > stay.checkOut ? t('departureWillExtend') : t('departureWillShorten')}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {pending ? t('savingStay') : t('departureConfirm')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={reset}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-50"
        >
          {t('cancelEdit')}
        </button>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900';
