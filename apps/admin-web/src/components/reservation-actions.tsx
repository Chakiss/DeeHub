'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { ReservationDetail } from '@/lib/api';
import {
  cancelReservation,
  checkInReservation,
  checkOutReservation,
} from '@/app/properties/[propertyId]/reservations/actions';

/**
 * What can be done to a booking, given its current state.
 *
 * The buttons are derived from status rather than always shown and disabled:
 * a front desk under pressure should not have to work out why "Check out" is
 * greyed on a booking that has not arrived. The API enforces the same rules —
 * this only avoids offering a click that is certain to fail.
 */
export function ReservationActions({
  propertyId,
  reservation,
  canCancel,
  canCheckIn,
  canCheckOut,
}: {
  propertyId: string;
  reservation: ReservationDetail;
  canCancel: boolean;
  canCheckIn: boolean;
  canCheckOut: boolean;
}) {
  const t = useTranslations('reservations');
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  const { status, version, id } = reservation;

  const showCheckIn = canCheckIn && (status === 'CONFIRMED' || status === 'PENDING');
  const showCheckOut = canCheckOut && status === 'CHECKED_IN';
  const showCancel = canCancel && ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(status);

  /*
   * Is anyone leaving before the night they booked?
   *
   * Only then is there anything to hand back, and only then is the question
   * worth asking — a guest departing on their booked date has no unused night,
   * so offering to "put tonight back on sale" would be an option that does
   * nothing. The API decides for real; this only avoids asking pointlessly, so
   * a day's drift between the browser's clock and the property's timezone
   * costs an unnecessary question rather than a wrong outcome.
   */
  const todayLocal = new Date().toISOString().slice(0, 10);
  const nightsStillHeld = reservation.stays.some((stay) => stay.checkOut > todayLocal);

  function run(action: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) {
    setError(null);
    setStale(false);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setConfirming(false);
        setReason('');
        router.refresh();
        return;
      }
      // A version mismatch is not a failure the user caused, and retrying with
      // the same stale version would fail identically. Offer a reload instead.
      // Plain CONFLICT is a real business refusal — its message is shown.
      if (result.error?.code === 'VERSION_MISMATCH') {
        setStale(true);
        return;
      }
      setError(result.error?.message ?? null);
    });
  }

  if (!showCheckIn && !showCheckOut && !showCancel) {
    const anyPermission = canCancel || canCheckIn || canCheckOut;
    return (
      <p className="text-sm text-stone-500">{anyPermission ? t('noActions') : t('readOnly')}</p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {showCheckIn && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => checkInReservation(propertyId, id, version))}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {pending ? t('working') : t('checkIn')}
          </button>
        )}
        {showCheckOut && !departing && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              // Leaving on the booked date is the ordinary case and stays one
              // click. Leaving early is a decision, so it gets asked.
              if (nightsStillHeld) {
                setDeparting(true);
                return;
              }
              run(() => checkOutReservation(propertyId, id, version));
            }}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {pending ? t('working') : t('checkOut')}
          </button>
        )}
        {showCancel && !confirming && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {t('cancel')}
          </button>
        )}
      </div>

      {/*
        Leaving early: two outcomes, both spelled out.

        Deliberately not a checkbox next to one button. The difference between
        these is whether a room the hotel is holding goes on sale in the next
        few seconds, and a tickbox is something a busy person clicks past. Two
        labelled buttons make the choice the click itself.
      */}
      {departing && (
        <div className="space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-4">
          <div>
            <p className="text-sm font-medium text-sky-900">{t('earlyTitle')}</p>
            <p className="mt-1 text-sm text-sky-800">{t('earlyExplain')}</p>
            <p className="mt-2 text-sm font-medium text-sky-900">{t('earlyWarning')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => checkOutReservation(propertyId, id, version, true))}
              className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
            >
              {pending ? t('working') : t('earlyRelease')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => checkOutReservation(propertyId, id, version, false))}
              className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-900 hover:bg-white/60 disabled:opacity-50"
            >
              {pending ? t('working') : t('earlyKeep')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setDeparting(false)}
              className="rounded-md px-3 py-1.5 text-sm text-sky-800 hover:bg-white/60 disabled:opacity-50"
            >
              {t('earlyDismiss')}
            </button>
          </div>
        </div>
      )}

      {/*
        An inline panel rather than window.confirm: cancelling releases
        inventory and is not undoable, so it deserves the explanation and a
        place to record why.
      */}
      {confirming && (
        <div className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-4">
          <div>
            <p className="text-sm font-medium text-rose-900">{t('cancelTitle')}</p>
            <p className="mt-1 text-sm text-rose-700">{t('cancelExplain')}</p>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-rose-900">{t('cancelReason')}</span>
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-sm text-ink-900"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => cancelReservation(propertyId, id, version, reason.trim() || undefined))
              }
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {pending ? t('working') : t('cancelConfirm')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setReason('');
              }}
              className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm text-rose-800 hover:bg-white/60 disabled:opacity-50"
            >
              {t('cancelDismiss')}
            </button>
          </div>
        </div>
      )}

      {stale && (
        <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>{t('staleData')}</span>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium"
          >
            {t('reload')}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
