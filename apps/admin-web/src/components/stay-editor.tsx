'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState, useTransition } from 'react';
import type { ModifyStayInput, RatePlan, ReservationDetail, RoomType } from '@/lib/api';
import { modifyStay } from '@/app/properties/[propertyId]/reservations/actions';

type Stay = ReservationDetail['stays'][number];

/** Bookings that have neither started nor ended can still be changed. */
const MODIFIABLE = ['PENDING', 'CONFIRMED'];

/**
 * Change one stay's dates, room type or occupancy.
 *
 * Only the fields the user actually touched are sent. A PATCH that echoed
 * everything back would re-price nights nobody changed, moving a guest's quote
 * because someone edited the adult count.
 */
export function StayEditor({
  propertyId,
  reservationId,
  status,
  version,
  stay,
  roomTypes,
  ratePlans,
}: {
  propertyId: string;
  reservationId: string;
  status: string;
  version: number;
  stay: Stay;
  roomTypes: RoomType[];
  ratePlans: RatePlan[];
}) {
  const t = useTranslations('reservations');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [checkIn, setCheckIn] = useState(stay.checkIn);
  const [checkOut, setCheckOut] = useState(stay.checkOut);
  const [roomTypeId, setRoomTypeId] = useState(stay.roomTypeId);
  const [ratePlanId, setRatePlanId] = useState(stay.ratePlanId);
  const [adults, setAdults] = useState(stay.adults);
  const [children, setChildren] = useState(stay.children);
  const [reason, setReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const plansFor = useMemo(() => {
    const map = new Map<string, RatePlan[]>();
    for (const plan of ratePlans) {
      if (!plan.isActive && plan.id !== stay.ratePlanId) continue;
      const list = map.get(plan.roomTypeId) ?? [];
      list.push(plan);
      map.set(plan.roomTypeId, list);
    }
    return map;
  }, [ratePlans, stay.ratePlanId]);

  if (!MODIFIABLE.includes(status)) return null;

  const roomType = roomTypes.find((candidate) => candidate.id === roomTypeId);
  const plans = plansFor.get(roomTypeId) ?? [];

  function reset() {
    setCheckIn(stay.checkIn);
    setCheckOut(stay.checkOut);
    setRoomTypeId(stay.roomTypeId);
    setRatePlanId(stay.ratePlanId);
    setAdults(stay.adults);
    setChildren(stay.children);
    setReason('');
    setError(null);
    setOpen(false);
  }

  function save() {
    setError(null);
    setNotice(null);

    if (checkOut <= checkIn) {
      setError(t('checkOutAfterCheckIn'));
      return;
    }

    // Only what changed. See the component comment.
    const input: ModifyStayInput = {
      version,
      ...(checkIn !== stay.checkIn ? { checkIn } : {}),
      ...(checkOut !== stay.checkOut ? { checkOut } : {}),
      ...(roomTypeId !== stay.roomTypeId ? { roomTypeId } : {}),
      ...(ratePlanId !== stay.ratePlanId ? { ratePlanId } : {}),
      ...(adults !== stay.adults ? { adults } : {}),
      ...(children !== stay.children ? { children } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };

    startTransition(async () => {
      const result = await modifyStay(propertyId, reservationId, stay.id, input);
      if (result.ok) {
        // Losing a room number matters to whoever checks this guest in, so it
        // is said out loud rather than left to be noticed on the stay view.
        setNotice(result.modified?.roomAssignmentCleared ? t('assignmentCleared') : null);
        setOpen(false);
        router.refresh();
        return;
      }
      if (result.error?.code === 'VERSION_MISMATCH') {
        setError(t('staleData'));
        return;
      }
      setError(result.error?.message ?? null);
    });
  }

  if (!open) {
    return (
      <div className="mt-3">
        {notice && (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {notice}
          </p>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {t('editStay')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
      <p className="text-sm font-medium text-slate-900">{t('editStayTitle')}</p>
      <p className="text-xs text-slate-500">{t('modifyHint')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('checkIn')}>
          <input
            type="date"
            value={checkIn}
            onChange={(event) => setCheckIn(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('checkOut')}>
          <input
            type="date"
            value={checkOut}
            onChange={(event) => setCheckOut(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('roomType')}>
          <select
            value={roomTypeId}
            onChange={(event) => {
              const next = event.target.value;
              setRoomTypeId(next);
              // Plans belong to one room type: keeping the old one would price
              // a suite off the standard-room plan, and the API refuses it.
              setRatePlanId(
                next === stay.roomTypeId ? stay.ratePlanId : (plansFor.get(next)?.[0]?.id ?? ''),
              );
            }}
            className={inputClass}
          >
            {roomTypes.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('ratePlan')}>
          {plans.length === 0 ? (
            <p className="py-1.5 text-sm text-rose-600">{t('noRatePlan')}</p>
          ) : (
            <select
              value={ratePlanId}
              onChange={(event) => setRatePlanId(event.target.value)}
              className={inputClass}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="flex gap-3">
          <Field label={t('adults')}>
            <input
              type="number"
              min={1}
              max={roomType?.maxAdults ?? 20}
              value={adults}
              onChange={(event) => setAdults(Number(event.target.value) || 1)}
              className={`${inputClass} w-20`}
            />
          </Field>
          <Field label={t('children')}>
            <input
              type="number"
              min={0}
              max={roomType?.maxChildren ?? 20}
              value={children}
              onChange={(event) => setChildren(Number(event.target.value) || 0)}
              className={`${inputClass} w-20`}
            />
          </Field>
        </div>
        <Field label={t('modifyReason')}>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      {error && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || plans.length === 0}
          onClick={save}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? t('savingStay') : t('saveStay')}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      {children}
    </label>
  );
}
