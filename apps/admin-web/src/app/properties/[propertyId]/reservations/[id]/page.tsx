import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ApiError, api, type ReservationDetail } from '@/lib/api';
import { businessDate, formatMoney } from '@/lib/dates';
import { ReservationActions } from '@/components/reservation-actions';
import { StayEditor } from '@/components/stay-editor';
import { StayExtender } from '@/components/stay-extender';

/** Bookings a modification can still take apart and re-hold. */
const MODIFIABLE = ['PENDING', 'CONFIRMED'];
/** Bookings that still have a future to add nights to. */
const EXTENDABLE = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];

const STATUS_TONE: Record<string, string> = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-200',
  CHECKED_IN: 'bg-sky-50 text-sky-700 ring-sky-200',
  CHECKED_OUT: 'bg-slate-100 text-slate-600 ring-slate-200',
  CANCELLED: 'bg-rose-50 text-rose-700 ring-rose-200',
  NO_SHOW: 'bg-rose-50 text-rose-700 ring-rose-200',
  EXPIRED: 'bg-slate-100 text-slate-500 ring-slate-200',
};

export default async function ReservationDetailPage({
  params,
}: {
  params: Promise<{ propertyId: string; id: string }>;
}) {
  const { propertyId, id } = await params;
  const t = await getTranslations('reservations');

  let reservation: ReservationDetail;
  try {
    reservation = await api.reservation(propertyId, id);
  } catch (error) {
    // The API answers 404 both for a booking that does not exist and for one
    // belonging to another property — it deliberately does not distinguish, so
    // an id cannot be probed through a URL the caller is allowed to reach.
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  // Room types and rate plans only for whoever can actually change a booking;
  // two extra requests on a read-only view would be paid for nothing.
  const me = await api.me();
  const capabilities = me.capabilities;
  const canModify = capabilities.includes('reservation:modify');
  const [roomTypes, ratePlans, properties] = canModify
    ? await Promise.all([api.roomTypes(propertyId), api.ratePlans(propertyId), api.properties()])
    : [[], [], []];

  /*
   * Today in the PROPERTY's timezone, which decides which of the two editors a
   * stay gets. A Bangkok hotel served from a European browser must not think a
   * guest arriving today is still arriving tomorrow.
   */
  const today = businessDate(
    properties.find((property) => property.id === propertyId)?.timezone ?? 'Asia/Bangkok',
  );

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/properties/${propertyId}/reservations`}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← {t('backToList')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="tabular text-xl font-semibold tracking-tight text-slate-900">
            {reservation.code}
          </h1>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
              STATUS_TONE[reservation.status] ?? 'bg-slate-100 text-slate-600 ring-slate-200'
            }`}
          >
            {reservation.status.replace('_', ' ').toLowerCase()}
          </span>
          <span className="text-xs uppercase tracking-wide text-slate-400">
            {reservation.source}
          </span>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title={t('booker')}>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <Field label={t('guest')} value={reservation.bookerName} />
              <Field label={t('email')} value={reservation.bookerEmail} />
              <Field label={t('phone')} value={reservation.bookerPhone} />
              <Field label={t('bookedOn')} value={formatInstant(reservation.createdAt)} />
              {reservation.checkedInAt && (
                <Field label={t('arrived')} value={formatInstant(reservation.checkedInAt)} />
              )}
              {reservation.checkedOutAt && (
                <Field label={t('departed')} value={formatInstant(reservation.checkedOutAt)} />
              )}
              {reservation.cancelledAt && (
                <Field label={t('cancelledOn')} value={formatInstant(reservation.cancelledAt)} />
              )}
              {reservation.cancellationReason && (
                <Field label={t('cancellationReason')} value={reservation.cancellationReason} />
              )}
            </dl>
            {reservation.specialRequests && (
              <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 ring-1 ring-inset ring-amber-200">
                <p className="text-xs font-medium text-amber-900">{t('specialRequests')}</p>
                <p className="mt-0.5 whitespace-pre-line text-sm text-amber-800">
                  {reservation.specialRequests}
                </p>
              </div>
            )}
          </Card>

          <Card title={t('roomsHeading')}>
            <ul className="space-y-4">
              {reservation.stays.map((stay) => (
                <li key={stay.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-900">{stay.roomTypeName}</span>
                    <span className="tabular text-sm text-slate-600">
                      {stay.checkIn} → {stay.checkOut}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-3">
                    <Field
                      label={t('occupancy')}
                      value={t('occupancyValue', {
                        adults: stay.adults,
                        children: stay.children,
                      })}
                    />
                    <Field
                      label={t('assignedRoom')}
                      value={stay.assignedRoomNumber ?? t('notAssigned')}
                    />
                    {stay.guestName && <Field label={t('guestName')} value={stay.guestName} />}
                  </dl>

                  {/*
                    Frozen per-night prices. Recomputing from the rate plan would
                    silently rewrite what the guest was quoted whenever rates move,
                    which is the one thing a booking record must never do.
                  */}
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
                      {t('nightlyRates')}
                    </summary>
                    <table className="mt-2 w-full text-sm">
                      <tbody>
                        {stay.nights.map((night) => (
                          <tr key={night.date} className="border-b border-slate-100 last:border-0">
                            <td className="tabular py-1 text-slate-600">{night.date}</td>
                            <td className="tabular py-1 text-right text-slate-800">
                              {formatMoney(night.amount, reservation.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>

                  <p className="tabular mt-2 text-right text-sm font-medium text-slate-800">
                    {formatMoney(stay.subtotal.amount, stay.subtotal.currency)}
                  </p>

                  {/*
                   * One editor or the other, never both. A stay that has begun
                   * can only gain nights at the end — the full editor releases
                   * the old ones first, which the API refuses once a guest has
                   * slept in one — and offering both would put two date fields
                   * on screen where only one of them can be saved.
                   */}
                  {canModify &&
                    (stay.checkIn <= today || reservation.status === 'CHECKED_IN'
                      ? EXTENDABLE.includes(reservation.status) && (
                          <StayExtender
                            propertyId={propertyId}
                            reservationId={reservation.id}
                            version={reservation.version}
                            stay={stay}
                          />
                        )
                      : MODIFIABLE.includes(reservation.status) && (
                          <StayEditor
                            propertyId={propertyId}
                            reservationId={reservation.id}
                            status={reservation.status}
                            version={reservation.version}
                            stay={stay}
                            roomTypes={roomTypes.filter(
                              (roomType) => roomType.isActive || roomType.id === stay.roomTypeId,
                            )}
                            ratePlans={ratePlans}
                          />
                        ))}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t('chargesHeading')}>
            <dl className="space-y-1.5 text-sm">
              <Amount label={t('subtotal')} money={reservation.subtotal} />
              <Amount label={t('tax')} money={reservation.tax} />
              <Amount label={t('serviceCharge')} money={reservation.serviceCharge} />
              <div className="border-t border-slate-200 pt-1.5">
                <Amount label={t('grandTotal')} money={reservation.total} strong />
              </div>
            </dl>
          </Card>

          <Card title={t('actions')}>
            <ReservationActions
              propertyId={propertyId}
              reservation={reservation}
              canCancel={capabilities.includes('reservation:cancel')}
              canCheckIn={capabilities.includes('reservation:checkin')}
              canCheckOut={capabilities.includes('reservation:checkout')}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Stored UTC, rendered in the viewer's locale. Business DATES are never touched. */
function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value ?? '—'}</dd>
    </div>
  );
}

function Amount({
  label,
  money,
  strong = false,
}: {
  label: string;
  money: { amount: number; currency: string };
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'font-medium text-slate-900' : 'text-slate-600'}>{label}</dt>
      <dd className={`tabular ${strong ? 'font-semibold text-slate-900' : 'text-slate-800'}`}>
        {formatMoney(money.amount, money.currency)}
      </dd>
    </div>
  );
}
