'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { ReservationDetail } from '@/lib/api';
import { updateBooker } from '@/app/properties/[propertyId]/reservations/actions';

/**
 * Who booked, and how to reach them — editable in place.
 *
 * A walk-in gets typed as "เสี่ยวหยู/Wechat" at 05:49 and the real name and
 * phone arrive at breakfast. Until this existed the fix was a new booking,
 * which is a new code, a new folio and a lie in the audit trail.
 *
 * Contact text only, on purpose. Dates, rooms and prices each move inventory
 * or money and live on the stay editors below; putting them next to a phone
 * field would make the harmless edit look like the dangerous one.
 */
export function BookerEditor({
  propertyId,
  reservation,
}: {
  propertyId: string;
  reservation: Pick<
    ReservationDetail,
    'id' | 'version' | 'bookerName' | 'bookerEmail' | 'bookerPhone' | 'guestId'
  >;
}) {
  const t = useTranslations('reservations');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(reservation.bookerName);
  const [email, setEmail] = useState(reservation.bookerEmail ?? '');
  const [phone, setPhone] = useState(reservation.bookerPhone ?? '');
  // On by default: a walk-in's profile was created from this very booking, so
  // fixing one without the other leaves the CRM with the typo.
  const [applyToGuest, setApplyToGuest] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setName(reservation.bookerName);
    setEmail(reservation.bookerEmail ?? '');
    setPhone(reservation.bookerPhone ?? '');
    setError(null);
    setOpen(false);
  }

  function save() {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('bookerNameRequired'));
      return;
    }

    // Only what changed goes over the wire, so the audit entry shows the
    // correction and not a re-statement of every field.
    const input = {
      version: reservation.version,
      ...(trimmedName !== reservation.bookerName ? { bookerName: trimmedName } : {}),
      ...(email.trim() !== (reservation.bookerEmail ?? '')
        ? { bookerEmail: email.trim() || null }
        : {}),
      ...(phone.trim() !== (reservation.bookerPhone ?? '')
        ? { bookerPhone: phone.trim() || null }
        : {}),
    };
    if (Object.keys(input).length === 1) {
      setError(t('bookerUnchanged'));
      return;
    }

    startTransition(async () => {
      const result = await updateBooker(propertyId, reservation.id, {
        ...input,
        ...(reservation.guestId && applyToGuest ? { applyToGuest: true } : {}),
      });
      if (result.ok) {
        setNotice(result.booker?.guestUpdated ? t('bookerAndGuestSaved') : t('bookerSaved'));
        setOpen(false);
        router.refresh();
        return;
      }
      setError(
        result.error?.code === 'VERSION_MISMATCH'
          ? t('staleData')
          : (result.error?.message ?? null),
      );
    });
  }

  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
          className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-ink-700 hover:bg-sunk/70"
        >
          {t('editBooker')}
        </button>
        {notice && (
          <p role="status" className="text-xs text-emerald-700">
            {notice}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      aria-label={t('editBookerTitle')}
      className="mt-3 space-y-3 rounded-lg border border-stone-300 bg-sunk p-3"
    >
      <p className="text-sm font-medium text-ink-900">{t('editBookerTitle')}</p>
      <p className="text-xs text-stone-500">{t('editBookerHint')}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">{t('guest')}</span>
          <input
            type="text"
            value={name}
            required
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">{t('email')}</span>
          <input
            type="email"
            value={email}
            maxLength={320}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">{t('phone')}</span>
          <input
            type="tel"
            value={phone}
            maxLength={40}
            onChange={(event) => setPhone(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      {reservation.guestId && (
        <label className="flex items-center gap-2 text-sm text-ink-800">
          <input
            type="checkbox"
            checked={applyToGuest}
            onChange={(event) => setApplyToGuest(event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('applyToGuest')}
        </label>
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
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {pending ? t('saving') : t('saveBooker')}
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
    </form>
  );
}

const inputClass =
  'w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900';
