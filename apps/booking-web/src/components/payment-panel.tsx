'use client';

import Script from 'next/script';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { PaymentMethod } from '@/lib/api';
import { pollPayment, startPayment } from '@/app/[org]/[code]/actions';
import { formatMoney } from '@/lib/format';
import type { Locale } from '@/i18n/locale';

declare global {
  interface Window {
    Omise?: {
      setPublicKey(key: string): void;
      createToken(
        type: 'card',
        card: Record<string, string | number>,
        callback: (statusCode: number, response: { id?: string; message?: string }) => void,
      ): void;
    };
  }
}

const INPUT =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

type Phase =
  | { kind: 'choose' }
  | { kind: 'card' }
  | { kind: 'busy' }
  | { kind: 'qr'; intentId: string; qr: string; expiresAt: string | null }
  | { kind: 'redirect' }
  | { kind: 'error'; message: string };

/**
 * Paying for a held booking, in the browser.
 *
 * The card form talks to Omise.js, which turns the card into a one-time
 * token in the guest's browser; only that token reaches our server. That is
 * the whole PCI story: no card number ever crosses this site. PromptPay
 * needs nothing typed — the API starts the charge, we show the QR and poll
 * until the provider says paid. Either way the API is the judge; this
 * component only asks and shows.
 */
export function PaymentPanel({
  org,
  code,
  bookingCode,
  email,
  amountMinor,
  currency,
  methods,
  omisePublicKey,
  initialIntent,
}: {
  org: string;
  code: string;
  bookingCode: string;
  email: string;
  amountMinor: number;
  currency: string;
  methods: PaymentMethod[];
  omisePublicKey: string | null;
  /** Set when the guest came back from a 3-D Secure page: poll it. */
  initialIntent: string | null;
}) {
  const t = useTranslations('pay');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialIntent ? { kind: 'busy' } : { kind: 'choose' });
  const polling = useRef<string | null>(initialIntent);
  const [omiseReady, setOmiseReady] = useState(false);

  const confirmationUrl = `/${org}/${code}/bookings/${bookingCode}?email=${encodeURIComponent(email)}`;
  const returnUri = `${typeof window === 'undefined' ? '' : window.location.origin}/${org}/${code}/pay/${bookingCode}?email=${encodeURIComponent(email)}`;

  useEffect(() => {
    if (!polling.current) return;
    let cancelled = false;
    const intentId = polling.current;
    const tick = async () => {
      const result = await pollPayment({ org, code, bookingCode, intentId, email });
      if (cancelled) return;
      if (result.outcome === 'PAID' || result.outcome === 'PAID_UNCONFIRMABLE') {
        polling.current = null;
        router.push(confirmationUrl);
        return;
      }
      if (result.outcome === 'FAILED') {
        polling.current = null;
        setPhase({
          kind: 'error',
          message: result.reason ? t('declined', { reason: result.reason }) : t('failed'),
        });
        return;
      }
      if (result.outcome === 'EXPIRED') {
        polling.current = null;
        setPhase({ kind: 'error', message: t('expired') });
        return;
      }
      if (result.outcome === 'ERROR') {
        polling.current = null;
        setPhase({ kind: 'error', message: result.message });
        return;
      }
      // Still pending: keep the QR on screen if we have one.
      if (result.qrImageUri && phase.kind !== 'qr') {
        setPhase({ kind: 'qr', intentId, qr: result.qrImageUri, expiresAt: result.expiresAt });
      }
      window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === 'qr' ? phase.intentId : initialIntent]);

  async function begin(method: PaymentMethod, token?: string) {
    setPhase({ kind: 'busy' });
    const result = await startPayment({
      org,
      code,
      bookingCode,
      method,
      ...(token ? { token } : {}),
      returnUri,
    });
    if (result.status === 'PAID') {
      router.push(confirmationUrl);
      return;
    }
    if (result.status === 'PENDING') {
      if (result.authorizeUri) {
        setPhase({ kind: 'redirect' });
        window.location.assign(result.authorizeUri);
        return;
      }
      polling.current = result.intentId;
      setPhase({
        kind: 'qr',
        intentId: result.intentId,
        qr: result.qrImageUri ?? '',
        expiresAt: result.expiresAt,
      });
      return;
    }
    if (result.status === 'DECLINED') {
      setPhase({ kind: 'error', message: t('declined', { reason: result.reason }) });
      return;
    }
    if (result.status === 'UNAVAILABLE') {
      setPhase({ kind: 'error', message: t('noOnline') });
      return;
    }
    setPhase({ kind: 'error', message: result.message });
  }

  function onCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const [month, year] = String(form.get('expiry') ?? '')
      .split('/')
      .map((part) => part.trim());
    if (!window.Omise || !omisePublicKey) {
      setPhase({ kind: 'error', message: t('failed') });
      return;
    }
    setPhase({ kind: 'busy' });
    window.Omise.setPublicKey(omisePublicKey);
    window.Omise.createToken(
      'card',
      {
        name: String(form.get('name') ?? ''),
        number: String(form.get('number') ?? '').replace(/\s+/g, ''),
        expiration_month: Number(month),
        expiration_year: 2000 + Number(year),
        security_code: String(form.get('cvc') ?? ''),
      },
      (status, response) => {
        if (status === 200 && response.id) void begin('CARD', response.id);
        else setPhase({ kind: 'error', message: response.message ?? t('cardInvalid') });
      },
    );
  }

  return (
    <div className="space-y-4">
      {omisePublicKey && (
        <Script
          src="https://cdn.omise.co/omise.js"
          strategy="afterInteractive"
          onLoad={() => setOmiseReady(true)}
        />
      )}

      {phase.kind === 'choose' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {methods.includes('CARD') && omisePublicKey && (
            <button
              type="button"
              onClick={() => setPhase({ kind: 'card' })}
              className="rounded-xl border border-stone-300 bg-white px-4 py-4 text-left font-medium hover:border-brand-500"
            >
              {t('card')}
            </button>
          )}
          {methods.includes('PROMPTPAY') && (
            <button
              type="button"
              onClick={() => void begin('PROMPTPAY')}
              className="rounded-xl border border-stone-300 bg-white px-4 py-4 text-left font-medium hover:border-brand-500"
            >
              {t('promptpay')}
            </button>
          )}
        </div>
      )}

      {phase.kind === 'card' && (
        <form onSubmit={onCard} className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">{t('cardName')}</span>
            <input name="name" required autoComplete="cc-name" className={INPUT} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">{t('cardNumber')}</span>
            <input
              name="number"
              required
              inputMode="numeric"
              autoComplete="cc-number"
              className={INPUT}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-700">{t('expiry')}</span>
              <input
                name="expiry"
                required
                placeholder="MM/YY"
                autoComplete="cc-exp"
                className={INPUT}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-700">{t('cvc')}</span>
              <input
                name="cvc"
                required
                inputMode="numeric"
                autoComplete="cc-csc"
                className={INPUT}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={!omiseReady}
            className="w-full rounded-lg bg-brand-600 px-5 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {t('payNow', { amount: formatMoney(amountMinor, currency, locale) })}
          </button>
          <p className="text-xs text-stone-500">{t('secure')}</p>
        </form>
      )}

      {phase.kind === 'busy' && <p className="text-center text-ink-700">{t('paying')}</p>}
      {phase.kind === 'redirect' && <p className="text-center text-ink-700">{t('redirecting')}</p>}

      {phase.kind === 'qr' && (
        <div className="space-y-3 text-center">
          <p className="font-medium">{t('scan')}</p>
          {phase.qr && <img src={phase.qr} alt="PromptPay QR" className="mx-auto w-64" />}
          <p className="text-lg font-semibold tabular">
            {formatMoney(amountMinor, currency, locale)}
          </p>
          <p className="text-sm text-ink-700">{t('waiting')}</p>
          {phase.expiresAt && (
            <p className="text-xs text-stone-500">
              {t('qrExpires', {
                time: new Date(phase.expiresAt).toLocaleTimeString(
                  locale === 'th' ? 'th-TH' : 'en-GB',
                  { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' },
                ),
              })}
            </p>
          )}
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="space-y-3">
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {phase.message}
          </p>
          <button
            type="button"
            onClick={() => setPhase({ kind: 'choose' })}
            className="text-sm font-medium text-brand-600"
          >
            ← {t('back')}
          </button>
        </div>
      )}
    </div>
  );
}
