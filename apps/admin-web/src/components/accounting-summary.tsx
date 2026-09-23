import { getTranslations } from 'next-intl/server';
import { formatMoney } from '@/lib/dates';
import type { AccountingSummary } from '@/lib/api';

/**
 * The month, at a glance.
 *
 * Four tiles because there are four questions an owner opens this page with:
 * what came in, what went out, what is left, and what the Revenue Department
 * is owed. The last one is a liability rather than a result, so it is styled
 * apart from the other three — it is not money the hotel has.
 */
export async function AccountingSummaryTiles({
  summary,
  locale,
}: {
  summary: AccountingSummary;
  locale: string;
}) {
  const t = await getTranslations('accounting');
  const currency = summary.currency;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label={t('revenue')}
        value={formatMoney(summary.revenue.amount, currency, locale)}
        delta={delta(summary.revenue.amount, summary.previous.revenue.amount)}
        deltaLabel={t('vsPrevious')}
      />
      <Tile
        label={t('expenses')}
        value={formatMoney(summary.expenses.amount, currency, locale)}
        delta={delta(summary.expenses.amount, summary.previous.expenses.amount)}
        deltaLabel={t('vsPrevious')}
      />
      <Tile
        label={t('netProfit')}
        value={formatMoney(summary.netProfit.amount, currency, locale)}
        delta={delta(summary.netProfit.amount, summary.previous.netProfit.amount)}
        deltaLabel={t('vsPrevious')}
        emphasis
        negative={summary.netProfit.amount < 0}
      />
      {/*
       * A VAT credit is shown as a credit rather than as a negative amount
       * owed: in a month with a big repair the hotel is owed money, and
       * "-4,200 to remit" reads as a mistake.
       */}
      <Tile
        label={summary.netVatPayable.amount < 0 ? t('vatCredit') : t('vatPayable')}
        value={formatMoney(Math.abs(summary.netVatPayable.amount), currency, locale)}
        muted
      />
    </div>
  );
}

function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

function Tile({
  label,
  value,
  delta: change,
  deltaLabel,
  emphasis = false,
  negative = false,
  muted = false,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaLabel?: string;
  emphasis?: boolean;
  negative?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-xl bg-sunk px-4 py-3">
      <p className="text-xs font-medium text-stone-600">{label}</p>
      <p
        className={[
          'tabular tracking-tight',
          emphasis ? 'text-2xl font-semibold' : 'text-xl font-semibold',
          negative ? 'text-red-700' : muted ? 'text-stone-700' : 'text-ink-900',
        ].join(' ')}
      >
        {value}
      </p>
      {change !== null && change !== undefined && deltaLabel ? (
        <p className="text-xs text-stone-500">
          {change > 0 ? '+' : ''}
          {change}% {deltaLabel}
        </p>
      ) : null}
    </div>
  );
}
