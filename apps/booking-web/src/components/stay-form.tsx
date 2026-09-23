import { getTranslations } from 'next-intl/server';
import type { StayQuery } from '@/lib/stay-query';

const INPUT =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * A GET form, no JavaScript needed: the answer is a URL that can be shared,
 * reloaded and — the reason it matters — arrived at from Google with the
 * dates already filled in.
 */
export async function StayForm({
  org,
  code,
  stay,
  min,
}: {
  org: string;
  code: string;
  stay: StayQuery;
  min: string;
}) {
  const t = await getTranslations('hotel');
  return (
    <form
      action={`/${org}/${code}/rooms`}
      method="get"
      className="grid gap-3 rounded-2xl border border-stone-200/70 bg-raised p-4 shadow-card sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end"
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('checkIn')}</span>
        <input
          type="date"
          name="checkIn"
          defaultValue={stay.checkIn}
          min={min}
          required
          className={INPUT}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('checkOut')}</span>
        <input
          type="date"
          name="checkOut"
          defaultValue={stay.checkOut}
          min={min}
          required
          className={INPUT}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('adults')}</span>
        <input
          type="number"
          name="adults"
          min={1}
          max={10}
          defaultValue={stay.adults}
          className={`${INPUT} w-20`}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink-700">{t('children')}</span>
        <input
          type="number"
          name="children"
          min={0}
          max={10}
          defaultValue={stay.children}
          className={`${INPUT} w-20`}
        />
      </label>
      <button
        type="submit"
        className="rounded-lg bg-brand-600 px-5 py-2.5 text-base font-medium text-white hover:bg-brand-700"
      >
        {t('search')}
      </button>
    </form>
  );
}
