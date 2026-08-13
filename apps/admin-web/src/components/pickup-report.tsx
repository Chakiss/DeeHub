import { getTranslations } from 'next-intl/server';
import type { Pickup } from '@/lib/api';
import { formatMoney } from '@/lib/dates';

/**
 * What was taken for each upcoming night since a past date.
 *
 * Looks FORWARD, unlike the performance report next to it, and that is the
 * whole point: pickup is the number a hotelier acts on. "We are twelve rooms
 * up on next weekend since Monday" is a decision about price; last week's
 * occupancy is a decision about nothing.
 *
 * Negative pickup is shown as negative, in red, without apology. A week losing
 * more than it takes is exactly the week somebody needs to look at.
 */
export async function PickupReport({ pickup }: { pickup: Pickup }) {
  const t = await getTranslations('pickup');

  if (pickup.asOfUsed === null) {
    return (
      <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-8 text-center">
        <p className="text-sm font-medium text-ink-700">{t('noBaseline')}</p>
        <p className="mx-auto mt-1 max-w-lg text-sm text-stone-500">{t('noBaselineHint')}</p>
      </div>
    );
  }

  const nights = pickup.nights;
  const totals = pickup.totals;

  return (
    <div className="space-y-3">
      {/* Said out loud, because "pickup since Monday" that quietly spans ten
          days is a different number from the one being read. */}
      {pickup.asOfUsed !== pickup.asOfRequested && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t('baselineMoved', { requested: pickup.asOfRequested, used: pickup.asOfUsed })}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          label={t('pickupRooms')}
          value={signed(totals.pickupRooms)}
          hint={t('pickupRoomsHint', { date: pickup.asOfUsed })}
          tone={tone(totals.pickupRooms)}
        />
        <Tile
          label={t('pickupRevenue')}
          value={
            totals.pickupRevenueMinor === null
              ? '—'
              : `${totals.pickupRevenueMinor < 0 ? '−' : '+'}${formatMoney(
                  Math.abs(totals.pickupRevenueMinor),
                  pickup.currency,
                )}`
          }
          hint={t('pickupRevenueHint')}
          tone={tone(totals.pickupRevenueMinor)}
        />
        <Tile
          label={t('onTheBooks')}
          value={String(totals.roomsSold)}
          hint={t('onTheBooksHint')}
          tone="text-ink-900"
        />
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
              <th className="px-3 py-2 font-medium">{t('date')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('was')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('now')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('change')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('revenueChange')}</th>
            </tr>
          </thead>
          <tbody>
            {nights.map((night) => (
              <tr key={night.date} className="border-b border-stone-100 last:border-0">
                <td className="tabular px-3 py-2 text-ink-700">{night.date}</td>
                <td className="tabular px-3 py-2 text-right text-stone-500">
                  {night.baselineRoomsSold ?? '—'}
                </td>
                <td className="tabular px-3 py-2 text-right text-ink-800">{night.roomsSold}</td>
                <td className={`tabular px-3 py-2 text-right ${tone(night.pickupRooms)}`}>
                  {signed(night.pickupRooms)}
                </td>
                <td className={`tabular px-3 py-2 text-right ${tone(night.pickupRevenueMinor)}`}>
                  {night.pickupRevenueMinor === null || night.pickupRevenueMinor === 0
                    ? '—'
                    : `${night.pickupRevenueMinor < 0 ? '−' : '+'}${formatMoney(
                        Math.abs(night.pickupRevenueMinor),
                        pickup.currency,
                      )}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Explicit sign on a positive number: "+3" reads as movement, "3" as a count. */
function signed(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '0';
  return value > 0 ? `+${String(value)}` : `−${String(Math.abs(value))}`;
}

function tone(value: number | null): string {
  if (value === null || value === 0) return 'text-stone-500';
  return value > 0 ? 'text-emerald-700' : 'text-rose-700';
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
      <p className="mt-1 text-xs text-stone-400">{hint}</p>
    </div>
  );
}
