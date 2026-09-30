'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import type { CancelQuote, CancelRefundInput, ReservationDetail } from '@/lib/api';
import { formatMoney } from '@/lib/dates';
import { FOLIO_PAYMENT_METHODS, type FolioPaymentMethod } from '@/lib/folio-types';
import {
  cancelReservation,
  getCancelQuote,
  checkInReservation,
  confirmReservation,
  markNoShow,
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
  today,
  timeZone,
  canCancel,
  canRefund,
  canCheckIn,
  canCheckOut,
  canNoShow,
}: {
  propertyId: string;
  reservation: ReservationDetail;
  /** The property's business date (ADR-0003), never the browser's. */
  today: string;
  /** The property's IANA timezone, for showing the cancellation deadline. */
  timeZone: string;
  canCancel: boolean;
  /** `folio:post`: recording a refund with the cancellation needs it too. */
  canRefund: boolean;
  canCheckIn: boolean;
  canCheckOut: boolean;
  /** `reservation:update`: closing a booking as a no-show. */
  canNoShow: boolean;
}) {
  const t = useTranslations('reservations');
  const tf = useTranslations('folio');
  const locale = useLocale();
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [markingNoShow, setMarkingNoShow] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  // The refund the desk is about to record. The API recomputes the quote itself;
  // what is shown here is only a suggestion to start from.
  const [quote, setQuote] = useState<CancelQuote | null>(null);
  const [quoteState, setQuoteState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundMethod, setRefundMethod] = useState<FolioPaymentMethod>('CASH');
  const [refundNote, setRefundNote] = useState('');

  const { status, version, id } = reservation;

  // A PENDING booking is one the hotel has not said yes to (a site booking
  // paying at the hotel). The API refuses to check it in; the step it wants
  // is the confirmation, offered here in its place.
  const showConfirm = canCheckIn && status === 'PENDING';
  const showCheckIn = canCheckIn && status === 'CONFIRMED';
  const showCheckOut = canCheckOut && status === 'CHECKED_IN';
  // The arrival date has passed and they never showed (not on the day itself: a
  // late flight still needs its room). `today` is the property's business date;
  // the API enforces the same rule (NO_SHOW_TOO_EARLY).
  const earliestCheckIn = reservation.stays.map((stay) => stay.checkIn).sort()[0] ?? '';
  const showNoShow =
    canNoShow && status === 'CONFIRMED' && earliestCheckIn !== '' && today > earliestCheckIn;
  const showCancel = canCancel && ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(status);

  /*
   * Is anyone leaving before the night they booked?
   *
   * Only then is there anything to hand back, and only then is the question
   * worth asking — a guest departing on their booked date has no unused night,
   * so offering to "put tonight back on sale" would be an option that does
   * nothing.
   *
   * `today` is the PROPERTY's business date, computed by the page. It used to
   * be the browser clock's UTC date here, excused as "an unnecessary question
   * rather than a wrong outcome" — but in Thailand that unnecessary question
   * fired for every on-time departure before 7am, which is when hotel
   * checkouts actually happen. Found by the e2e suite crossing midnight
   * Asia/Bangkok while UTC was still yesterday (ADR-0003's exact warning).
   * The API still decides for real.
   */
  const nightsStillHeld = reservation.stays.some((stay) => stay.checkOut > today);

  /** Fetch the quote and start the refund fields from its suggestion. */
  function loadQuote(isStale: () => boolean = () => false) {
    setQuoteState('loading');
    void getCancelQuote(propertyId, id).then((result) => {
      if (isStale()) return;
      if (!result.ok || !result.quote) {
        setQuoteState('failed');
        return;
      }
      setQuote(result.quote);
      setQuoteState('idle');
      setRefundAmount((result.quote.suggestedRefundMinor / 100).toFixed(2));
      setRefundMethod(result.quote.suggestedMethod ?? 'CASH');
      setRefundNote('');
    });
  }

  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;
    setQuote(null);
    loadQuote(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, propertyId, id]);

  /**
   * Baht typed, satang sent. An amount with more than 2 decimals is refused
   * rather than rounded: the desk should see what will actually be paid out.
   */
  function refundMinor(): { minor: number } | { error: 'invalid' | 'decimals' } {
    const text = refundAmount.replace(/,/g, '').trim();
    if (text === '') return { minor: 0 };
    if (!/^\d+(\.\d*)?$/.test(text)) return { error: 'invalid' };
    if (/\.\d{3,}/.test(text)) return { error: 'decimals' };
    const [whole = '0', fraction = ''] = text.split('.');
    return { minor: Number(whole) * 100 + Number(fraction.padEnd(2, '0')) };
  }

  function submitCancel() {
    let refund: CancelRefundInput | undefined;
    if (quote && canRefund) {
      const parsed = refundMinor();
      if ('error' in parsed) {
        setError(
          parsed.error === 'decimals' ? t('cancelAmountDecimals') : t('cancelAmountInvalid'),
        );
        return;
      }
      const amountMinor = parsed.minor;
      if (amountMinor !== quote.suggestedRefundMinor && refundNote.trim() === '') {
        setError(t('cancelNoteRequired'));
        return;
      }
      // Always sent once a quote was shown, so the audit records what was
      // quoted and what was refunded for every cancel made through this panel.
      refund = {
        amountMinor,
        method: refundMethod,
        ...(refundNote.trim() ? { note: refundNote.trim() } : {}),
      };
    }
    run(() => cancelReservation(propertyId, id, version, reason.trim() || undefined, refund));
  }

  const NO_SHOW_ERRORS = ['NO_SHOW_TOO_EARLY', 'INVALID_STATE_TRANSITION', 'VERSION_MISMATCH'];

  function run(
    action: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>,
    /** Translate this action's own refusals; anything else falls through. */
    translateError?: (code: string) => string | null,
  ) {
    setError(null);
    setStale(false);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setConfirming(false);
        setMarkingNoShow(false);
        setReason('');
        setRefundNote('');
        router.refresh();
        return;
      }
      // A version mismatch is not a failure the user caused, and retrying with
      // the same stale version would fail identically. Offer a reload instead.
      // Plain CONFLICT is a real business refusal — its message is shown.
      // The quote the desk saw is out of date (another desk refunded, a payment
      // was voided): show the fresh suggestion and ask for the note.
      const own = result.error ? (translateError?.(result.error.code) ?? null) : null;
      if (own) {
        setError(own);
        return;
      }
      if (result.error?.code === 'REFUND_NOTE_REQUIRED') {
        loadQuote();
        setError(t('cancelNoteRequired'));
        return;
      }
      if (result.error?.code === 'VERSION_MISMATCH') {
        setStale(true);
        return;
      }
      setError(result.error?.message ?? null);
    });
  }

  if (!showConfirm && !showCheckIn && !showCheckOut && !showNoShow && !showCancel) {
    const anyPermission = canCancel || canCheckIn || canCheckOut || canNoShow;
    return (
      <p className="text-sm text-stone-500">{anyPermission ? t('noActions') : t('readOnly')}</p>
    );
  }

  return (
    <div className="space-y-3">
      {showConfirm && <p className="text-sm text-amber-800">{t('confirmHint')}</p>}
      <div className="flex flex-wrap gap-2">
        {showConfirm && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => confirmReservation(propertyId, id, version))}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {pending ? t('working') : t('confirmBooking')}
          </button>
        )}
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
        {showNoShow && !markingNoShow && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setMarkingNoShow(true)}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-stone-50 disabled:opacity-50"
          >
            {t('noShow')}
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

      {/* Same inline-panel pattern as cancel: closing a booking is not undoable. */}
      {markingNoShow && (
        <div className="space-y-3 rounded-lg border border-stone-300 bg-stone-50 p-4">
          <div>
            <p className="text-sm font-medium text-ink-900">{t('noShowTitle')}</p>
            <p className="mt-1 text-sm text-ink-700">{t('noShowExplain')}</p>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-ink-700">{t('cancelReason')}</span>
            <input
              type="text"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => markNoShow(propertyId, id, version, reason.trim() || undefined),
                  (code) =>
                    NO_SHOW_ERRORS.includes(code) ? t(`noShowError${code}` as never) : null,
                )
              }
              className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-50"
            >
              {pending ? t('working') : t('noShowConfirm')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setMarkingNoShow(false);
                setReason('');
              }}
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-white/60 disabled:opacity-50"
            >
              {t('cancelDismiss')}
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
          {quoteState === 'loading' && (
            <p className="text-sm text-rose-800">{t('cancelQuoteLoading')}</p>
          )}
          {quoteState === 'failed' && (
            <p className="text-sm text-rose-800">{t('cancelQuoteFailed')}</p>
          )}
          {quote && (
            <div className="space-y-3 rounded-md border border-rose-200 bg-white/70 p-3">
              <p className="text-sm text-rose-900" data-testid="cancel-policy-line">
                {quote.policy
                  ? t('cancelPolicyLine', {
                      hours: quote.policy.noticeHours,
                      percent: quote.policy.refundPercent,
                      deadline: new Intl.DateTimeFormat(locale, {
                        timeZone,
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                        hourCycle: 'h23',
                      }).format(new Date(quote.policy.deadline)),
                      state: quote.policy.inTime ? t('cancelInTime') : t('cancelPastDeadline'),
                    })
                  : t('cancelNoPolicy')}
              </p>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-rose-800">{t('cancelPaid')}</dt>
                  <dd className="tabular text-ink-900">
                    {formatMoney(quote.paidMinor, quote.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-rose-800">{t('cancelAlreadyRefunded')}</dt>
                  <dd className="tabular text-ink-900">
                    {formatMoney(quote.refundedMinor, quote.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-rose-800">{t('cancelSuggested')}</dt>
                  <dd className="tabular font-medium text-ink-900">
                    {formatMoney(quote.suggestedRefundMinor, quote.currency)}
                  </dd>
                </div>
              </dl>
              {canRefund && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-medium text-rose-900">
                      {t('cancelRefundAmount')}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={refundAmount}
                      onChange={(event) => setRefundAmount(event.target.value)}
                      className="tabular mt-1 w-full rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-sm text-ink-900"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-rose-900">
                      {t('cancelRefundMethod')}
                    </span>
                    <select
                      value={refundMethod}
                      onChange={(event) =>
                        setRefundMethod(event.target.value as FolioPaymentMethod)
                      }
                      className="mt-1 w-full rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-sm text-ink-900"
                    >
                      {FOLIO_PAYMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {tf(`method${method}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="text-xs font-medium text-rose-900">
                      {t('cancelRefundNote')}
                    </span>
                    <input
                      type="text"
                      value={refundNote}
                      maxLength={500}
                      onChange={(event) => setRefundNote(event.target.value)}
                      className="mt-1 w-full rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-sm text-ink-900"
                    />
                  </label>
                </div>
              )}
            </div>
          )}
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
              onClick={submitCancel}
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
