'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { AccountingSettings } from '@/lib/api';
import { saveAccountingSettings } from '@/app/properties/[propertyId]/accounting/settings/actions';

/**
 * Who the hotel is to the Revenue Department.
 *
 * Asked at sign-up and editable afterwards, because the answers differ per
 * customer — some are registered for VAT, some are not, some trade as a
 * company and some in their own name — and every figure downstream depends on
 * which. It is not a preferences screen: getting `taxpayerType` or
 * `vatRegistered` wrong changes the numbers rather than the appearance.
 */
export function AccountingSettingsForm({
  propertyId,
  settings,
}: {
  propertyId: string;
  settings: AccountingSettings;
}) {
  const t = useTranslations('accounting');

  const [taxpayerType, setTaxpayerType] = useState(settings.taxpayerType ?? '');
  const [taxId, setTaxId] = useState(settings.taxId ?? '');
  const [branchCode, setBranchCode] = useState(settings.branchCode);
  const [legalNameTh, setLegalNameTh] = useState(settings.legalNameTh ?? '');
  const [legalNameEn, setLegalNameEn] = useState(settings.legalNameEn ?? '');
  const [addressTh, setAddressTh] = useState(settings.addressTh ?? '');
  const [vatRegistered, setVatRegistered] = useState(settings.vatRegistered);
  const [vatRegisteredFrom, setVatRegisteredFrom] = useState(settings.vatRegisteredFrom ?? '');
  const [withholdingEnabled, setWithholdingEnabled] = useState(settings.withholdingEnabled);
  const [localLevyEnabled, setLocalLevyEnabled] = useState(settings.localLevyEnabled);
  const [localLevyRate, setLocalLevyRate] = useState(String(settings.localLevyRateBp / 100));
  const [fiscalMonth, setFiscalMonth] = useState(settings.fiscalYearStartMonth);

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    // Refused here as well as by the server: a registered property with no
    // effective date leaves every VAT report guessing at the boundary month.
    if (vatRegistered && vatRegisteredFrom === '') {
      setError(t('vatRegisteredFromRequired'));
      return;
    }

    setSaving(true);
    const result = await saveAccountingSettings(propertyId, {
      taxpayerType: taxpayerType === '' ? null : (taxpayerType as 'INDIVIDUAL' | 'JURISTIC'),
      taxId: taxId.trim() === '' ? null : taxId.trim(),
      branchCode: branchCode.trim() === '' ? '00000' : branchCode.trim(),
      legalNameTh: legalNameTh.trim() === '' ? null : legalNameTh.trim(),
      legalNameEn: legalNameEn.trim() === '' ? null : legalNameEn.trim(),
      addressTh: addressTh.trim() === '' ? null : addressTh.trim(),
      vatRegistered,
      vatRegisteredFrom: vatRegistered ? vatRegisteredFrom : null,
      withholdingEnabled,
      localLevyEnabled,
      localLevyRateBp: localLevyEnabled ? Math.round(Number(localLevyRate) * 100) : 0,
      fiscalYearStartMonth: fiscalMonth,
    });
    setSaving(false);

    if (!result.ok) {
      setError(
        result.error?.message?.includes('check digit')
          ? t('taxIdInvalid')
          : (result.error?.message ?? t('failed')),
      );
      return;
    }
    setSaved(true);
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
      <Section title={t('taxpayerType')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="taxpayer-type" label={t('taxpayerType')}>
            <select
              id="taxpayer-type"
              value={taxpayerType}
              onChange={(event) => setTaxpayerType(event.target.value)}
              className={INPUT}
            >
              <option value="">—</option>
              <option value="INDIVIDUAL">{t('taxpayerINDIVIDUAL')}</option>
              <option value="JURISTIC">{t('taxpayerJURISTIC')}</option>
            </select>
            {/* Not a preference: it decides which basis the income-tax reports
                use, so the first figure the owner sees is the one they file on. */}
            <p className="text-xs text-stone-500">
              {taxpayerType === 'JURISTIC' ? t('basisHintACCRUAL') : t('basisHintCASH')}
            </p>
          </Field>

          <Field id="tax-id" label={t('taxId')}>
            <input
              id="tax-id"
              type="text"
              inputMode="numeric"
              maxLength={20}
              value={taxId}
              onChange={(event) => setTaxId(event.target.value)}
              placeholder="0-1055-56012-34-1"
              className={INPUT}
            />
          </Field>

          <Field id="branch-code" label={t('branchCode')}>
            <input
              id="branch-code"
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={branchCode}
              onChange={(event) => setBranchCode(event.target.value)}
              className={INPUT}
            />
            <p className="text-xs text-stone-500">00000 = {t('headOffice')}</p>
          </Field>

          <Field id="fiscal-month" label={t('fiscalYearStart')}>
            <select
              id="fiscal-month"
              value={fiscalMonth}
              onChange={(event) => setFiscalMonth(Number(event.target.value))}
              className={INPUT}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          </Field>

          <Field id="legal-name-th" label={t('legalNameTh')}>
            <input
              id="legal-name-th"
              type="text"
              maxLength={200}
              value={legalNameTh}
              onChange={(event) => setLegalNameTh(event.target.value)}
              className={INPUT}
            />
          </Field>

          <Field id="legal-name-en" label={t('legalNameEn')}>
            <input
              id="legal-name-en"
              type="text"
              maxLength={200}
              value={legalNameEn}
              onChange={(event) => setLegalNameEn(event.target.value)}
              className={INPUT}
            />
          </Field>
        </div>

        <Field id="address-th" label={t('addressTh')}>
          <textarea
            id="address-th"
            rows={3}
            maxLength={500}
            value={addressTh}
            onChange={(event) => setAddressTh(event.target.value)}
            className={INPUT}
          />
        </Field>
      </Section>

      <Section title={t('vatRegistered')}>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={vatRegistered}
            onChange={(event) => setVatRegistered(event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('vatRegistered')}
        </label>

        {vatRegistered ? (
          <Field id="vat-from" label={t('vatRegisteredFrom')}>
            <input
              id="vat-from"
              type="date"
              required
              value={vatRegisteredFrom}
              onChange={(event) => setVatRegisteredFrom(event.target.value)}
              className={INPUT}
            />
          </Field>
        ) : (
          /* The threshold is the reason someone lands on this screen a second
             time, so it is stated rather than left to be remembered. */
          <p className="rounded-md bg-sunk px-3 py-2 text-sm text-stone-600">
            {t('vatThresholdNote')}
          </p>
        )}
      </Section>

      <Section title={t('otherTaxes')}>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={withholdingEnabled}
            onChange={(event) => setWithholdingEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('withholdingEnabled')}
        </label>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={localLevyEnabled}
            onChange={(event) => setLocalLevyEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-stone-300"
          />
          {t('localLevyEnabled')}
        </label>

        {localLevyEnabled ? (
          <Field id="levy-rate" label={t('localLevyRate')}>
            <input
              id="levy-rate"
              type="text"
              inputMode="decimal"
              value={localLevyRate}
              onChange={(event) => setLocalLevyRate(event.target.value)}
              className={`${INPUT} max-w-[10rem]`}
            />
            {/* No default is offered: the rate comes from each province's own
                ordinance, so any number the system suggested would be wrong
                somewhere. */}
            <p className="text-xs text-stone-500">{t('localLevyRateHint')}</p>
          </Field>
        ) : null}
      </Section>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="rounded-md bg-success-50 px-3 py-2 text-sm text-success-700">
          {t('settingsSaved')}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {saving ? t('saving') : t('save')}
      </button>
    </form>
  );
}

const INPUT =
  'w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk disabled:text-stone-500';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-2xl border border-stone-200/70 bg-white p-5 shadow-card">
      <legend className="px-1 text-sm font-semibold text-ink-900">{title}</legend>
      {children}
    </fieldset>
  );
}

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
