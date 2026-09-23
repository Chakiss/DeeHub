'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createBooking, type BookingFormState } from '@/app/[org]/[code]/actions';

const INPUT =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export function BookingForm({
  hidden,
}: {
  /** Everything the API needs that the guest does not type: dates, room, plan. */
  hidden: Record<string, string>;
}) {
  const t = useTranslations('book');
  const [state, action, pending] = useActionState<BookingFormState, FormData>(createBooking, {});

  return (
    <form action={action} className="space-y-4">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('name')}</span>
        <input name="name" required maxLength={200} autoComplete="name" className={INPUT} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('email')}</span>
        <input
          name="email"
          type="email"
          required
          maxLength={320}
          autoComplete="email"
          className={INPUT}
        />
        <span className="mt-1 block text-xs text-stone-500">{t('emailHint')}</span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('phone')}</span>
        <input
          name="phone"
          type="tel"
          required
          maxLength={40}
          autoComplete="tel"
          className={INPUT}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('requests')}</span>
        <textarea name="specialRequests" rows={2} maxLength={1000} className={INPUT} />
      </label>

      {state.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {t(state.error === 'invalid' ? 'failed' : state.error)}
        </p>
      )}

      <p className="text-xs text-stone-500">{t('agree')}</p>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand-600 px-5 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? t('submitting') : t('continue')}
      </button>
      <p className="text-center text-xs text-stone-500">{t('holdNote')}</p>
    </form>
  );
}
