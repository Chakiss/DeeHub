'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/dates';
import type { Expense } from '@/lib/api';
import { voidExpense } from '@/app/properties/[propertyId]/accounting/actions';

interface Props {
  propertyId: string;
  expenses: Expense[];
  currency: string;
  locale: string;
  canVoid: boolean;
}

/**
 * What has been recorded this month.
 *
 * Voided rows stay in the list, struck through and carrying their reason. A
 * line that disappears takes the evidence with it, and "this was recorded and
 * then reversed" is the fact somebody is looking for when the month does not
 * match the bank statement.
 */
export function ExpenseList({ propertyId, expenses, currency, locale, canVoid }: Props) {
  const t = useTranslations('accounting');
  const [voiding, setVoiding] = useState<Expense | null>(null);

  if (expenses.length === 0) {
    return <p className="px-4 py-6 text-sm text-stone-500">{t('noExpenses')}</p>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
              <Th>{t('expenseDate')}</Th>
              <Th>{t('description')}</Th>
              <Th>{t('category')}</Th>
              <Th>{t('vendor')}</Th>
              <Th className="text-right">{t('netLabel')}</Th>
              <Th className="text-right">{t('vatLabel')}</Th>
              <Th className="text-right">{t('paid')}</Th>
              {canVoid ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => {
              const isVoid = expense.voidedAt !== null;
              return (
                <tr key={expense.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 tabular text-stone-600">{expense.expenseDate}</td>
                  <td
                    className={`px-3 py-2 ${isVoid ? 'text-stone-400 line-through' : 'text-ink-900'}`}
                  >
                    {expense.description}
                    {isVoid && expense.voidedReason ? (
                      <span className="ml-2 text-xs text-stone-500 no-underline">
                        {t('voidedBecause', { reason: expense.voidedReason })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-stone-600">
                    {locale === 'th' ? expense.categoryNameTh : expense.categoryNameEn}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{expense.vendorName ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular">
                    {formatMoney(expense.net.amount, currency, locale)}
                  </td>
                  <td className="px-3 py-2 text-right tabular text-stone-600">
                    {expense.vat.amount === 0
                      ? '—'
                      : formatMoney(expense.vat.amount, currency, locale)}
                  </td>
                  <td className="px-3 py-2 text-right tabular">
                    {expense.paidDate === null ? (
                      <span className="text-stone-400">{t('notPaidYet')}</span>
                    ) : (
                      formatMoney(expense.paid.amount, currency, locale)
                    )}
                  </td>
                  {canVoid ? (
                    <td className="px-3 py-2 text-right">
                      {isVoid ? null : (
                        <button
                          type="button"
                          onClick={() => setVoiding(expense)}
                          className="rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70"
                        >
                          {t('void')}
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {voiding ? (
        <VoidDialog
          propertyId={propertyId}
          expense={voiding}
          currency={currency}
          locale={locale}
          onClose={() => setVoiding(null)}
        />
      ) : null}
    </>
  );
}

function VoidDialog({
  propertyId,
  expense,
  currency,
  locale,
  onClose,
}: {
  propertyId: string;
  expense: Expense;
  currency: string;
  locale: string;
  onClose: () => void;
}) {
  const t = useTranslations('accounting');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('void')}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-stone-200/70 bg-white p-6 shadow-card">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">{t('void')}</h2>
          <p className="text-sm text-stone-600">
            {expense.description} · {formatMoney(expense.gross.amount, currency, locale)}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="void-reason" className="block text-sm font-medium text-ink-700">
            {t('voidReason')}
          </label>
          <input
            id="void-reason"
            type="text"
            required
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            disabled={pending || reason.trim().length === 0}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await voidExpense(propertyId, expense.id, reason.trim());
                if (!result.ok) {
                  setError(result.error?.message ?? t('failed'));
                  return;
                }
                onClose();
              });
            }}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? t('saving') : t('void')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}
