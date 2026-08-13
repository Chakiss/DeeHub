'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { Folio } from '@/lib/api';
import {
  FOLIO_CHARGE_KINDS,
  FOLIO_PAYMENT_METHODS,
  type FolioChargeKind,
  type FolioPaymentKind,
  type FolioPaymentMethod,
} from '@/lib/folio-types';
import {
  postFolioCharge,
  recordFolioPayment,
  voidFolioLine,
} from '@/app/properties/[propertyId]/reservations/actions';
import { formatMoney } from '@/lib/dates';

/**
 * The guest's account, and the two things a front desk does to it.
 *
 * The balance leads, in the largest type on the panel, because it is the only
 * number anyone standing at a desk is actually looking for. Everything else is
 * there so they can see how it was arrived at.
 *
 * A negative balance is labelled as the hotel owing the guest rather than shown
 * as a minus sign. "−฿1,200" next to the word "Balance" is read as "they owe
 * 1,200" about as often as not, and the two are opposite instructions.
 */
export function FolioPanel({
  propertyId,
  reservationId,
  initial,
  canPost,
  canVoid,
}: {
  propertyId: string;
  reservationId: string;
  initial: Folio;
  canPost: boolean;
  canVoid: boolean;
}) {
  const t = useTranslations('folio');

  const [folio, setFolio] = useState(initial);
  const [form, setForm] = useState<'CHARGE' | 'PAYMENT' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [chargeKind, setChargeKind] = useState<FolioChargeKind>('MINIBAR');
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeNote, setChargeNote] = useState('');
  const [chargeTaxable, setChargeTaxable] = useState(true);

  const [paymentKind, setPaymentKind] = useState<FolioPaymentKind>('PAYMENT');
  const [paymentMethod, setPaymentMethod] = useState<FolioPaymentMethod>('CASH');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');

  const currency = folio.currency;

  /**
   * Baht in, satang stored.
   *
   * Everything below the API boundary is integer minor units (ADR-0003), and
   * nobody at a front desk types satang. Rounding here rather than sending a
   * float keeps the one place that converts visible.
   */
  function toMinor(value: string): number | null {
    const parsed = Number(value.replace(/,/g, '').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }

  function apply(result: { ok: boolean; folio?: Folio; error?: { message: string } }) {
    if (!result.ok || !result.folio) {
      setError(result.error?.message ?? t('failed'));
      return;
    }
    setFolio(result.folio);
    setForm(null);
    setError(null);
  }

  function submitCharge() {
    const amount = toMinor(chargeAmount);
    if (amount === null) {
      setError(t('amountRequired'));
      return;
    }
    startTransition(async () => {
      apply(
        await postFolioCharge(propertyId, reservationId, {
          kind: chargeKind,
          amount,
          taxable: chargeTaxable,
          ...(chargeNote.trim() ? { description: chargeNote.trim() } : {}),
        }),
      );
      setChargeAmount('');
      setChargeNote('');
    });
  }

  function submitPayment() {
    const amount = toMinor(paymentAmount);
    if (amount === null) {
      setError(t('amountRequired'));
      return;
    }
    startTransition(async () => {
      apply(
        await recordFolioPayment(propertyId, reservationId, {
          kind: paymentKind,
          method: paymentMethod,
          amount,
          ...(paymentReference.trim() ? { reference: paymentReference.trim() } : {}),
        }),
      );
      setPaymentAmount('');
      setPaymentReference('');
    });
  }

  function requestVoid(kind: 'CHARGE' | 'PAYMENT', id: string) {
    // A reason is required by the API, and asking for it here rather than
    // sending a placeholder is the difference between an audit trail that
    // explains a reversal and one that records that somebody clicked.
    const reason = window.prompt(t('voidReason'));
    if (!reason?.trim()) return;
    startTransition(async () => {
      apply(await voidFolioLine(propertyId, reservationId, { kind, id }, reason.trim()));
    });
  }

  const owed = folio.totals.balance;

  return (
    // A <section> only carries role="region" once it has an accessible name,
    // which is also what lets a screen reader announce where the guest's money
    // is on a long booking page.
    <section
      aria-labelledby="folio-heading"
      className="space-y-3 rounded-2xl bg-white shadow-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="folio-heading" className="text-sm font-semibold text-ink-900">
          {t('title')}
        </h2>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-stone-500">
            {owed < 0 ? t('hotelOwes') : t('balance')}
          </p>
          <p
            className={`tabular text-2xl font-semibold ${
              owed > 0 ? 'text-ink-900' : owed < 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {formatMoney(Math.abs(owed), currency)}
          </p>
          {owed === 0 && <p className="text-xs text-emerald-700">{t('settled')}</p>}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Figure label={t('rooms')} value={formatMoney(folio.totals.roomSubtotal, currency)} />
        <Figure label={t('extras')} value={formatMoney(folio.totals.extrasSubtotal, currency)} />
        <Figure
          label={t('serviceAndTax')}
          value={formatMoney(folio.totals.serviceCharge + folio.totals.tax, currency)}
        />
        <Figure label={t('paid')} value={formatMoney(folio.totals.paid, currency)} />
      </dl>

      <Lines title={t('roomNights')}>
        {folio.roomCharges.map((line) => (
          <Line
            key={`${line.stayId}-${line.date}`}
            left={`${line.date} · ${line.roomTypeName}`}
            right={formatMoney(line.amount, currency)}
          />
        ))}
      </Lines>

      {folio.extraCharges.length > 0 && (
        <Lines title={t('extraCharges')}>
          {folio.extraCharges.map((line) => (
            <Line
              key={line.id}
              voided={line.voidedAt !== null}
              left={`${t(`kind${line.kind}`)}${line.description ? ` · ${line.description}` : ''}`}
              meta={
                line.voidedAt
                  ? t('voidedBecause', { reason: line.voidedReason ?? '' })
                  : `${line.businessDate}${line.postedBy ? ` · ${line.postedBy}` : ''}${
                      line.taxable ? '' : ` · ${t('untaxed')}`
                    }`
              }
              right={formatMoney(line.amount, currency)}
              onVoid={canVoid && !line.voidedAt ? () => requestVoid('CHARGE', line.id) : undefined}
              voidLabel={t('void')}
            />
          ))}
        </Lines>
      )}

      {folio.payments.length > 0 && (
        <Lines title={t('paymentsTitle')}>
          {folio.payments.map((line) => (
            <Line
              key={line.id}
              voided={line.voidedAt !== null}
              left={`${line.kind === 'REFUND' ? t('refund') : t('payment')} · ${t(
                `method${line.method}`,
              )}`}
              meta={
                line.voidedAt
                  ? t('voidedBecause', { reason: line.voidedReason ?? '' })
                  : `${line.businessDate}${line.recordedBy ? ` · ${line.recordedBy}` : ''}${
                      line.reference ? ` · ${line.reference}` : ''
                    }`
              }
              right={`${line.kind === 'REFUND' ? '−' : ''}${formatMoney(line.amount, currency)}`}
              onVoid={canVoid && !line.voidedAt ? () => requestVoid('PAYMENT', line.id) : undefined}
              voidLabel={t('void')}
            />
          ))}
        </Lines>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      {canPost && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              setForm(form === 'CHARGE' ? null : 'CHARGE');
              setError(null);
            }}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-sunk/70"
          >
            {t('addCharge')}
          </button>
          <button
            type="button"
            onClick={() => {
              setForm(form === 'PAYMENT' ? null : 'PAYMENT');
              setError(null);
            }}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
          >
            {t('takePayment')}
          </button>
        </div>
      )}

      {canPost && form === 'CHARGE' && (
        <div className="grid gap-3 rounded-lg border border-stone-300 bg-sunk p-3 sm:grid-cols-2">
          <Field label={t('chargeKind')}>
            <select
              aria-label={t('chargeKind')}
              value={chargeKind}
              onChange={(event) => setChargeKind(event.target.value as FolioChargeKind)}
              className={inputClass}
            >
              {FOLIO_CHARGE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind${kind}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('amount')}>
            <input
              aria-label={t('amount')}
              inputMode="decimal"
              value={chargeAmount}
              onChange={(event) => setChargeAmount(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t('note')}>
            <input
              aria-label={t('note')}
              value={chargeNote}
              onChange={(event) => setChargeNote(event.target.value)}
              className={inputClass}
            />
          </Field>
          <label className="flex items-end gap-2 pb-1 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={chargeTaxable}
              onChange={(event) => setChargeTaxable(event.target.checked)}
            />
            {t('taxable')}
          </label>
          <div className="sm:col-span-2">
            <button
              type="button"
              disabled={pending}
              onClick={submitCharge}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? t('saving') : t('addCharge')}
            </button>
          </div>
        </div>
      )}

      {canPost && form === 'PAYMENT' && (
        <div className="grid gap-3 rounded-lg border border-stone-300 bg-sunk p-3 sm:grid-cols-2">
          <Field label={t('direction')}>
            <select
              aria-label={t('direction')}
              value={paymentKind}
              onChange={(event) => setPaymentKind(event.target.value as FolioPaymentKind)}
              className={inputClass}
            >
              <option value="PAYMENT">{t('payment')}</option>
              <option value="REFUND">{t('refund')}</option>
            </select>
          </Field>
          <Field label={t('method')}>
            <select
              aria-label={t('method')}
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value as FolioPaymentMethod)}
              className={inputClass}
            >
              {FOLIO_PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`method${method}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('amount')}>
            <input
              aria-label={t('amount')}
              inputMode="decimal"
              value={paymentAmount}
              onChange={(event) => setPaymentAmount(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t('reference')}>
            <input
              aria-label={t('reference')}
              value={paymentReference}
              onChange={(event) => setPaymentReference(event.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="sm:col-span-2">
            <button
              type="button"
              disabled={pending}
              onClick={submitPayment}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? t('saving') : t('record')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="tabular text-ink-800">{value}</dd>
    </div>
  );
}

function Lines({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">{title}</p>
      <ul className="divide-y divide-stone-100 border-y border-stone-100">{children}</ul>
    </div>
  );
}

function Line({
  left,
  meta,
  right,
  voided,
  onVoid,
  voidLabel,
}: {
  left: string;
  meta?: string;
  right: string;
  voided?: boolean;
  onVoid?: () => void;
  voidLabel?: string;
}) {
  return (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      <span className={`min-w-0 flex-1 ${voided ? 'text-stone-400 line-through' : 'text-ink-700'}`}>
        {left}
        {meta && <span className="block text-xs text-stone-400 no-underline">{meta}</span>}
      </span>
      <span className={`tabular ${voided ? 'text-stone-400 line-through' : 'text-ink-800'}`}>
        {right}
      </span>
      {onVoid && (
        <button
          type="button"
          onClick={onVoid}
          className="shrink-0 rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-sunk/70"
        >
          {voidLabel}
        </button>
      )}
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900';
