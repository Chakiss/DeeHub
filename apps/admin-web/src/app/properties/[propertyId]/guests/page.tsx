import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { GuestList } from '@/components/guest-list';

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
  const [t, guests, me] = await Promise.all([
    getTranslations('guests'),
    api.guests(propertyId, q),
    api.me(),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      {/* A plain GET form: search survives a reload and can be linked to. */}
      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder={t('search')}
          aria-label={t('search')}
          className="w-full max-w-sm rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('search')}
        </button>
      </form>

      {guests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink-700">{q ? t('noMatch') : t('empty')}</p>
          {!q && <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('emptyHint')}</p>}
        </div>
      ) : (
        <GuestList
          propertyId={propertyId}
          guests={guests}
          // Merging is a `guest:update` action; a read-only viewer still sees
          // the flag, because knowing the guest book has duplicates in it is
          // useful even to someone who cannot fix them.
          canMerge={me.capabilities.includes('guest:update')}
        />
      )}

      <p className="text-xs text-stone-400">
        <Link href="?" className="underline hover:text-stone-600">
          {t('title')}
        </Link>{' '}
        · {t('duplicateHint')}
      </p>
    </div>
  );
}
