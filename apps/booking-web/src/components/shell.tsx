import Link from 'next/link';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { LocaleSwitcher } from './locale-switcher';

/**
 * The frame every hotel page sits in: the hotel's name (a link home), the
 * language switch, and one quiet line saying who runs the page. The hotel
 * is the brand here; DeeHub is the small print.
 */
export async function Shell({
  org,
  code,
  hotelName,
  children,
}: {
  org: string;
  code: string;
  hotelName: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations('app');
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-stone-200/70 bg-raised">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link href={`/${org}/${code}`} className="truncate text-lg font-semibold text-ink-900">
            {hotelName}
          </Link>
          <Suspense fallback={null}>
            <LocaleSwitcher />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-stone-200/70 py-6 text-center text-xs text-stone-500">
        <a href="https://deehubhotel.com" className="hover:text-ink-700">
          {t('poweredBy')}
        </a>
      </footer>
    </div>
  );
}
