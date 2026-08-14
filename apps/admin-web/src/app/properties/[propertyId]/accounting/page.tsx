import { getLocale, getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { businessDate } from '@/lib/dates';
import { AccountingSummaryTiles } from '@/components/accounting-summary';
import { ExpenseList } from '@/components/expense-list';
import { ExpenseQuickForm } from '@/components/expense-quick-form';

/**
 * The month, for whoever runs the hotel.
 *
 * Two audiences on one route, decided by capability rather than by role name:
 * a manager who records what the electricity cost sees the form and the list,
 * and an owner sees those plus the totals and the tax position. The server
 * decides — the API refuses the summary call for a manager regardless of what
 * this page renders (accounting-plan.md §6).
 */
export default async function AccountingPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ year?: string; month?: string; basis?: string }>;
}) {
  const { propertyId } = await params;
  const query = await searchParams;

  const [t, locale, properties, me] = await Promise.all([
    getTranslations('accounting'),
    getLocale(),
    api.properties(),
    api.me(),
  ]);

  const property = properties.find((candidate) => candidate.id === propertyId);
  const currency = property?.currency ?? 'THB';
  const timezone = property?.timezone ?? 'Asia/Bangkok';
  const today = businessDate(timezone);

  const canReadBooks = me.capabilities.includes('accounting:read');
  const canVoid = me.capabilities.includes('expense:void');

  // The month being looked at, defaulting to the one in progress — in the
  // property's timezone, never the server's.
  const year = Number(query.year ?? today.slice(0, 4));
  const month = Number(query.month ?? today.slice(5, 7));
  const basis = query.basis === 'CASH' || query.basis === 'ACCRUAL' ? query.basis : undefined;

  const monthStart = `${String(year)}-${String(month).padStart(2, '0')}-01`;
  const monthEnd =
    month === 12
      ? `${String(year + 1)}-01-01`
      : `${String(year)}-${String(month + 1).padStart(2, '0')}-01`;

  const [categories, vendors, settings, expenses, summary] = await Promise.all([
    api.expenseCategories(propertyId),
    api.vendors(propertyId),
    canReadBooks ? api.accountingSettings(propertyId) : Promise.resolve(null),
    api.expenses(propertyId, monthStart, monthEnd, { basis: 'ACCRUAL', includeVoided: true }),
    canReadBooks ? api.accountingSummary(propertyId, year, month, basis) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      {/* The line that keeps this a bookkeeping aid rather than a tax filing. */}
      {canReadBooks ? (
        <p className="rounded-xl border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-ink-800">
          {t('worksheetNotice')}
        </p>
      ) : null}

      {summary ? (
        <>
          <AccountingSummaryTiles summary={summary} locale={locale} />
          <p className="text-xs text-stone-500">{t(`basisHint${summary.basis}`)}</p>

          {summary.missingRecurring.length > 0 ? (
            <div className="rounded-xl border border-stone-200/70 bg-white px-4 py-3 shadow-card">
              <p className="text-sm font-medium text-ink-900">{t('checklist')}</p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {summary.missingRecurring.map((item) => (
                  <li
                    key={item.categoryId}
                    className="rounded-full bg-sunk px-3 py-1 text-sm text-ink-700"
                  >
                    {locale === 'th' ? item.categoryNameTh : item.categoryNameEn}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {/*
       * `min-w-0` on both children is load-bearing, not tidiness. A grid item
       * defaults to `min-width: auto`, so it refuses to shrink below its
       * content — and the expense table is 720px wide. Without it the table's
       * own `overflow-x-auto` never engages and the whole PAGE scrolls
       * sideways instead, which on a phone means the save button leaves the
       * screen. Covered by the phone-width case in accounting.spec.ts.
       */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
        <ExpenseQuickForm
          propertyId={propertyId}
          categories={categories}
          vendors={vendors}
          currency={currency}
          today={today}
          vatRegistered={settings?.vatRegistered ?? false}
          vatRateBp={700}
          locale={locale}
        />

        <div className="min-w-0 space-y-2">
          <h2 className="text-sm font-semibold text-ink-900">{t('recent')}</h2>
          <ExpenseList
            propertyId={propertyId}
            expenses={expenses}
            currency={currency}
            locale={locale}
            canVoid={canVoid}
          />
        </div>
      </div>

      {summary ? <ProfitLossTable summary={summary} locale={locale} /> : null}
    </div>
  );
}

async function ProfitLossTable({
  summary,
  locale,
}: {
  summary: NonNullable<Awaited<ReturnType<typeof api.accountingSummary>>>;
  locale: string;
}) {
  const t = await getTranslations('accounting');
  const { profitLoss: pl, currency } = summary;
  const { formatMoney } = await import('@/lib/dates');

  return (
    <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
      <table className="w-full min-w-[520px] text-sm">
        <caption className="px-4 pt-4 text-left text-sm font-semibold text-ink-900">
          {t('profitLoss')}
        </caption>
        <tbody>
          <Row
            label={t('roomRevenue')}
            amount={pl.revenue.room.amount}
            {...{ currency, locale, formatMoney }}
          />
          <Row
            label={t('extrasRevenue')}
            amount={pl.revenue.extras.amount}
            {...{ currency, locale, formatMoney }}
          />
          <Row
            label={t('otherRevenue')}
            amount={pl.revenue.other.amount}
            {...{ currency, locale, formatMoney }}
          />
          <Row
            label={t('serviceCharge')}
            amount={pl.revenue.serviceCharge.amount}
            {...{ currency, locale, formatMoney }}
          />
          <Row
            label={t('totalRevenue')}
            amount={pl.revenue.total.amount}
            strong
            {...{ currency, locale, formatMoney }}
          />

          {pl.expenseGroups.map((group) => (
            <Row
              key={group.group}
              label={t(`group${group.group}`)}
              amount={-group.total.amount}
              {...{ currency, locale, formatMoney }}
            />
          ))}
          <Row
            label={t('totalExpenses')}
            amount={-pl.totalExpenses.amount}
            strong
            {...{ currency, locale, formatMoney }}
          />
          <Row
            label={t('netProfit')}
            amount={pl.netProfit.amount}
            strong
            {...{ currency, locale, formatMoney }}
          />

          {pl.nonDeductibleExpenses.amount > 0 ? (
            <Row
              label={t('nonDeductible')}
              amount={-pl.nonDeductibleExpenses.amount}
              {...{ currency, locale, formatMoney }}
            />
          ) : null}

          {/* VAT sits below the result, because it is a liability and not part of it. */}
          <Row
            label={t('vatOutput')}
            amount={pl.vat.output.amount}
            muted
            {...{ currency, locale, formatMoney }}
          />
          <Row
            label={t('vatInput')}
            amount={pl.vat.reclaimableInput.amount}
            muted
            {...{ currency, locale, formatMoney }}
          />
        </tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  amount,
  currency,
  locale,
  formatMoney,
  strong = false,
  muted = false,
}: {
  label: string;
  amount: number;
  currency: string;
  locale: string;
  formatMoney: (amountMinor: number, currency: string, locale?: string) => string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <tr className="border-t border-stone-100">
      <td
        className={`px-4 py-2 ${strong ? 'font-semibold text-ink-900' : muted ? 'text-stone-500' : 'text-stone-700'}`}
      >
        {label}
      </td>
      <td
        className={`px-4 py-2 text-right tabular ${
          strong ? 'font-semibold text-ink-900' : muted ? 'text-stone-500' : 'text-ink-800'
        } ${amount < 0 && !muted ? 'text-red-700' : ''}`}
      >
        {formatMoney(amount, currency, locale)}
      </td>
    </tr>
  );
}
