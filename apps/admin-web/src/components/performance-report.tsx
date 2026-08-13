import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { Performance } from '@/lib/api';
import { dayLabel, formatMoney, formatMoneyCompact, isWeekend, weekdayLabel } from '@/lib/dates';

/**
 * The screen an owner opens every morning.
 *
 * Occupancy and RevPAR are the INDUSTRY definitions, measured against physical
 * rooms — those are the figures compared against an STR report or a previous
 * PMS. Sell-through is measured against allotment and answers a different
 * question: how much of what was offered actually sold. Publishing one number
 * and calling it "occupancy" would be wrong for somebody either way, and one
 * figure that does not match costs trust in all of them.
 */
export async function PerformanceReport({
  propertyId,
  performance,
}: {
  propertyId: string;
  performance: Performance;
}) {
  const t = await getTranslations('reports');
  const { totals, currency } = performance;

  const percent = (value: number | null) =>
    value === null ? '—' : `${String(Math.round(value * 100))}%`;
  const money = (value: number | null) =>
    value === null ? '—' : formatMoney(value, currency, 'en-US');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label={t('roomsSold')} hint={t('roomsSoldHint')} value={String(totals.roomsSold)} />
        <Metric label={t('revenue')} value={money(totals.revenueMinor)} />
        <Metric label={t('adr')} hint={t('adrHint')} value={money(totals.adrMinor)} />
        <Metric
          label={t('occupancy')}
          hint={t('occupancyHint')}
          value={percent(totals.occupancy)}
        />
        <Metric label={t('revpar')} hint={t('revparHint')} value={money(totals.revParMinor)} />
      </div>

      {/* Says why two tiles are blank, rather than leaving an owner to wonder
          whether the number is zero or the report is broken. */}
      {performance.roomsAvailable === null && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
          <p className="text-sm font-medium text-sky-900">{t('noRooms')}</p>
          <p className="mt-1 max-w-2xl text-sm text-sky-800">{t('noRoomsHint')}</p>
          <Link
            href={`/properties/${propertyId}/rooms`}
            className="mt-3 inline-block rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('addRooms')}
          </Link>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Metric
          label={t('sellThrough')}
          hint={t('sellThroughHint')}
          value={percent(totals.sellThrough)}
        />
        <Metric label={t('offered')} value={String(totals.allotment)} />
      </div>

      <section className="overflow-x-auto rounded-2xl bg-white shadow-card">
        <h2 className="border-b border-stone-200 px-4 py-2 text-sm font-medium text-ink-800">
          {t('byNight')}
        </h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
              <th className="px-3 py-2 font-medium">{t('date')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('roomsSold')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('offered')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('occupancy')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('sellThrough')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('adr')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {performance.nights.map((night) => (
              <tr
                key={night.date}
                className={`border-b border-stone-100 last:border-0 ${
                  isWeekend(night.date) ? 'bg-sunk/60' : ''
                }`}
              >
                <td className="px-3 py-2">
                  <span className="text-xs uppercase tracking-wide text-stone-400">
                    {weekdayLabel(night.date)}
                  </span>{' '}
                  <span className="tabular text-ink-800">{dayLabel(night.date)}</span>
                </td>
                <td className="tabular px-3 py-2 text-right text-ink-800">{night.roomsSold}</td>
                <td className="tabular px-3 py-2 text-right text-stone-500">{night.allotment}</td>
                <td className="tabular px-3 py-2 text-right text-ink-800">
                  {percent(night.occupancy)}
                </td>
                <td className="tabular px-3 py-2 text-right text-stone-600">
                  {percent(night.sellThrough)}
                </td>
                <td className="tabular px-3 py-2 text-right text-stone-600">
                  {night.adrMinor === null ? '—' : formatMoneyCompact(night.adrMinor)}
                </td>
                <td className="tabular px-3 py-2 text-right font-medium text-ink-800">
                  {night.revenueMinor === 0 ? '—' : formatMoneyCompact(night.revenueMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/*
 * The reference's stat tile: a sunken beige box whose NUMBER carries the
 * colour (ref/dashboard.jpg). The tone is hashed from the label — the same
 * tile is always the same colour, across renders, locales and range toggles,
 * without a counter that would drift on re-render.
 */
const METRIC_TONES = [
  'text-brand-600',
  'text-success-700',
  'text-accent-900',
  'text-ink-900',
  'text-brand-800',
] as const;

function metricTone(label: string): string {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return METRIC_TONES[hash % METRIC_TONES.length] as string;
}

function Metric({ label, hint, value }: { label: string; hint?: string; value: string }) {
  const tone = metricTone(label);
  return (
    <div className="rounded-xl bg-sunk p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</div>
      <div className={`tabular mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-stone-400">{hint}</div>}
    </div>
  );
}
