'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/dates';
import type { ExpenseCategory, Vendor } from '@/lib/api';
import { recordExpense } from '@/app/properties/[propertyId]/accounting/actions';

interface Props {
  propertyId: string;
  categories: ExpenseCategory[];
  vendors: Vendor[];
  currency: string;
  /** Today in the property's timezone, resolved on the server. */
  today: string;
  vatRegistered: boolean;
  vatRateBp: number;
  locale: string;
}

/**
 * Record a bill from the receipt in your hand.
 *
 * Built around the number an owner can actually see — the total printed at the
 * bottom of the slip — and works out the rest. Two things happen live as they
 * type, and both exist because they are the arithmetic people get wrong:
 *
 * - VAT is pulled out of the total, so nobody divides by 1.07 on a phone.
 * - The withholding line says what to actually pay the supplier and what to
 *   remit, because "3%" on its own does not tell you either number.
 *
 * The split shown here is a preview. The server recomputes it from the same
 * shared arithmetic and its answer is what gets stored — this must never be
 * the only place the sum is done.
 */
export function ExpenseQuickForm({
  propertyId,
  categories,
  vendors,
  currency,
  today,
  vatRegistered,
  vatRateBp,
  locale,
}: Props) {
  const t = useTranslations('accounting');

  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [includesVat, setIncludesVat] = useState(vatRegistered);
  const [description, setDescription] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [expenseDate, setExpenseDate] = useState(today);
  const [paid, setPaid] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [supplierDocNumber, setSupplierDocNumber] = useState('');
  const [whtRateBp, setWhtRateBp] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const category = categories.find((item) => item.id === categoryId);

  /**
   * Baht in the field, satang over the wire — the same convention the folio
   * uses. Rounding here rather than at the boundary keeps a typed "1070.50"
   * from arriving as 107049.99999.
   */
  const amountMinor = useMemo(() => {
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
  }, [amount]);

  const effectiveVatBp = vatRegistered && includesVat ? vatRateBp : 0;

  /** Preview only. The server's answer is the one that is stored. */
  const preview = useMemo(() => {
    if (amountMinor === 0) return null;
    const net =
      effectiveVatBp === 0
        ? amountMinor
        : Math.round((amountMinor * 10_000) / (10_000 + effectiveVatBp));
    const vat = amountMinor - net;
    const wht = whtRateBp === 0 ? 0 : Math.round((net * whtRateBp) / 10_000);
    return { net, vat, wht, payable: amountMinor - wht };
  }, [amountMinor, effectiveVatBp, whtRateBp]);

  function chooseCategory(id: string) {
    setCategoryId(id);
    const chosen = categories.find((item) => item.id === id);
    // Offer the category's usual rate, but only once the bill is over the
    // 1,000 baht threshold below which nothing need be withheld.
    const suggested = chosen?.defaultWhtRateBp ?? 0;
    setWhtRateBp(amountMinor >= 100_000 ? suggested : 0);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!categoryId) return setError(t('categoryRequired'));
    if (amountMinor <= 0) return setError(t('amountRequired'));
    if (description.trim().length === 0) return setError(t('descriptionRequired'));

    setSaving(true);
    const result = await recordExpense(propertyId, {
      categoryId,
      vendorId: vendorId === '' ? null : vendorId,
      description: description.trim(),
      amount: amountMinor,
      amountIs: 'GROSS',
      vatRateBp: effectiveVatBp,
      whtRateBp,
      expenseDate,
      paidDate: paid ? expenseDate : null,
      paymentMethod: paid ? paymentMethod : null,
      supplierDocNumber: supplierDocNumber.trim() === '' ? null : supplierDocNumber.trim(),
    });
    setSaving(false);

    if (!result.ok) {
      setError(
        result.error?.code === 'DUPLICATE_SUPPLIER_DOCUMENT'
          ? t('duplicateDocument')
          : (result.error?.message ?? t('failed')),
      );
      return;
    }

    setAmount('');
    setDescription('');
    setSupplierDocNumber('');
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-2xl border border-stone-200/70 bg-white p-5 shadow-card"
    >
      <h2 className="text-sm font-semibold text-ink-900">{t('recordExpense')}</h2>

      {/* The amount comes first and is the biggest thing on the screen,
          because it is the one number the person is holding. */}
      <Field id="expense-amount" label={t('amountOnReceipt')}>
        <input
          id="expense-amount"
          type="text"
          inputMode="decimal"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-3 text-right text-2xl tabular outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          placeholder="0.00"
        />
      </Field>

      {vatRegistered ? (
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={includesVat}
            onChange={(event) => setIncludesVat(event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('hasVat')}
        </label>
      ) : null}

      {preview ? (
        <dl className="grid grid-cols-2 gap-2 rounded-xl bg-sunk px-3 py-2 text-sm">
          <dt className="text-stone-600">{t('netLabel')}</dt>
          <dd className="text-right tabular text-ink-900">
            {formatMoney(preview.net, currency, locale)}
          </dd>
          <dt className="text-stone-600">{t('vatLabel')}</dt>
          <dd className="text-right tabular text-ink-900">
            {formatMoney(preview.vat, currency, locale)}
          </dd>
        </dl>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="expense-category" label={t('category')}>
          <select
            id="expense-category"
            value={categoryId}
            onChange={(event) => chooseCategory(event.target.value)}
            className={INPUT}
          >
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {locale === 'th' ? item.nameTh : item.nameEn}
              </option>
            ))}
          </select>
        </Field>

        <Field id="expense-description" label={t('description')}>
          <input
            id="expense-description"
            type="text"
            required
            maxLength={300}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={INPUT}
          />
        </Field>

        <Field id="expense-vendor" label={t('vendor')}>
          <select
            id="expense-vendor"
            value={vendorId}
            onChange={(event) => setVendorId(event.target.value)}
            className={INPUT}
          >
            <option value="">{t('noVendor')}</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </Field>

        <Field id="expense-date" label={t('expenseDate')}>
          <input
            id="expense-date"
            type="date"
            required
            value={expenseDate}
            onChange={(event) => setExpenseDate(event.target.value)}
            className={INPUT}
          />
        </Field>

        <Field id="expense-doc" label={t('supplierDocNumber')}>
          <input
            id="expense-doc"
            type="text"
            maxLength={100}
            value={supplierDocNumber}
            onChange={(event) => setSupplierDocNumber(event.target.value)}
            className={INPUT}
          />
        </Field>

        {(category?.defaultWhtRateBp ?? 0) > 0 || whtRateBp > 0 ? (
          <Field id="expense-wht" label={t('withholding')}>
            <select
              id="expense-wht"
              value={whtRateBp}
              onChange={(event) => setWhtRateBp(Number(event.target.value))}
              className={INPUT}
            >
              <option value={0}>{t('noWithholding')}</option>
              {[100, 200, 300, 500].map((rate) => (
                <option key={rate} value={rate}>
                  {(rate / 100).toFixed(0)}%
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>

      {/* The line that turns a percentage into two amounts a person can act on. */}
      {preview && whtRateBp > 0 ? (
        <p className="rounded-md bg-accent-50 px-3 py-2 text-sm text-ink-800">
          {t('withholdingHint', {
            paid: formatMoney(preview.payable, currency, locale),
            wht: formatMoney(preview.wht, currency, locale),
          })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={!paid}
            onChange={(event) => setPaid(!event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('notPaidYet')}
        </label>

        {paid ? (
          <select
            aria-label={t('paymentMethod')}
            value={paymentMethod}
            onChange={(event) => setPaymentMethod(event.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {['CASH', 'BANK_TRANSFER', 'PROMPTPAY', 'CARD', 'CHEQUE', 'OTHER'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-md bg-brand-600 px-3 py-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60 sm:w-auto sm:px-6"
      >
        {saving ? t('saving') : t('save')}
      </button>
    </form>
  );
}

const INPUT =
  'w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk disabled:text-stone-500';

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
    </div>
  );
}
