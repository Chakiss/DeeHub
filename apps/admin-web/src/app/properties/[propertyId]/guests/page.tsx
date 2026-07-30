import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/dates';

/**
 * Guest profiles.
 *
 * Organization-wide, not per property: somebody who stayed at one hotel in a
 * group is the same person at the next one, and that is the whole value of
 * keeping a profile. It lives under the property nav only because that is
 * where a front desk already is.
 */
export default async function GuestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { propertyId } = await params;
  const { q } = await searchParams;
  const [t, guests] = await Promise.all([getTranslations('guests'), api.guests(propertyId, q)]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      {/* A plain GET form: search survives a reload and can be linked to. */}
      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder={t('search')}
          aria-label={t('search')}
          className="w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('search')}
        </button>
      </form>

      {guests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-700">{q ? t('noMatch') : t('empty')}</p>
          {!q && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{t('emptyHint')}</p>}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                <th className="px-3 py-2 font-medium">{t('name')}</th>
                <th className="px-3 py-2 font-medium">{t('contact')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('stays')}</th>
                <th className="px-3 py-2 font-medium">{t('lastStay')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {guests.map((guest) => (
                <tr key={guest.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">
                      {[guest.firstName, guest.lastName].filter(Boolean).join(' ')}
                    </div>
                    {/* Flagged, never merged: two people can share an address. */}
                    {guest.possibleDuplicates > 0 && (
                      <div
                        title={t('duplicateHint')}
                        className="mt-0.5 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
                      >
                        {guest.possibleDuplicates === 1
                          ? t('duplicate', { count: guest.possibleDuplicates })
                          : t('duplicates', { count: guest.possibleDuplicates })}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    <div>{guest.email ?? '—'}</div>
                    {guest.phone && <div className="text-xs text-slate-400">{guest.phone}</div>}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-slate-800">{guest.stays}</td>
                  <td className="tabular px-3 py-2 text-slate-600">
                    {guest.lastStay ?? t('never')}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-slate-800">
                    {guest.revenueMinor > 0 ? formatMoney(guest.revenueMinor, 'THB') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-400">
        <Link href="?" className="underline hover:text-slate-600">
          {t('title')}
        </Link>{' '}
        · {t('duplicateHint')}
      </p>
    </div>
  );
}
