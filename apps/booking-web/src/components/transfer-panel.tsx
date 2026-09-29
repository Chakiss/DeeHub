import QRCode from 'qrcode';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatMoney } from '@/lib/format';
import type { Locale } from '@/i18n/locale';
import { promptPayPayload } from '@/lib/promptpay';

/**
 * "Pay by PromptPay": the bridge while the hotel has no card gateway.
 *
 * The QR carries the amount, so the guest scans and confirms rather than
 * typing a figure; the booking code goes in the transfer note so the desk
 * can match the money to the booking. Nothing here is automatic on the
 * hotel's side — the desk sees the transfer in its bank app and confirms
 * the booking from the dashboard, which is why the page says so plainly.
 */
export async function TransferPanel({
  promptPay,
  amountMinor,
  currency,
  bookingCode,
  hotelPhone,
  line,
  backHref,
}: {
  promptPay: { id: string; name: string | null };
  amountMinor: number;
  currency: string;
  bookingCode: string;
  hotelPhone: string | null;
  /** Where to send the slip; absent when the hotel gave no LINE link. */
  line?: { id: string | null; url: string } | null;
  backHref: string;
}) {
  const [t, locale] = await Promise.all([getTranslations('pay'), getLocale()]);
  const payload = currency === 'THB' ? promptPayPayload(promptPay.id, amountMinor) : null;
  const qr = payload ? await QRCode.toDataURL(payload, { margin: 1, width: 320 }) : null;
  const amount = formatMoney(amountMinor, currency, locale as Locale);

  return (
    <div className="rounded-2xl border border-stone-200/70 bg-raised p-5 shadow-card">
      <h2 className="text-base font-semibold">{t('transferTitle')}</h2>
      <p className="mt-1 text-sm text-ink-700">{t('transferBody', { amount })}</p>

      {qr && (
        <div className="mt-4 flex justify-center">
          <img
            src={qr}
            alt={t('transferQrAlt', { amount })}
            width={240}
            height={240}
            className="rounded-lg bg-white p-2 ring-1 ring-stone-200"
          />
        </div>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-700">{t('transferTo')}</dt>
        <dd className="font-medium">
          {promptPay.name ?? ''}
          {promptPay.name ? ' · ' : ''}
          <span className="tabular">{promptPay.id}</span>
        </dd>
        <dt className="text-ink-700">{t('transferAmount')}</dt>
        <dd className="tabular font-semibold">{amount}</dd>
        <dt className="text-ink-700">{t('transferNote')}</dt>
        <dd className="tabular font-medium">{bookingCode}</dd>
      </dl>

      <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {line
          ? t('transferThenLine', { code: bookingCode, phone: hotelPhone ?? '' })
          : t('transferThen', { phone: hotelPhone ?? '' })}
      </p>

      {line && (
        <div className="mt-3">
          <a
            href={line.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[44px] w-full items-center justify-center rounded-lg bg-[#047a35] px-4 py-2 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
          >
            {t('lineSendSlip')}
          </a>
          {line.id && (
            <p className="mt-1 text-center text-xs text-ink-700">{t('lineId', { id: line.id })}</p>
          )}
        </div>
      )}

      <a href={backHref} className="mt-4 inline-block text-sm font-medium underline">
        {t('back')}
      </a>
    </div>
  );
}
