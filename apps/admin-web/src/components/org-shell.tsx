import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { MainNav } from '@/components/main-nav';
import { PropertySwitcher } from '@/components/property-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Wordmark } from '@/components/wordmark';

/**
 * The app chrome for pages that belong to the ORGANIZATION rather than to one
 * property: /team and /account.
 *
 * These pages used to render a bare navy strip with nothing but the logo — the
 * pilot's first real user reached /team from the menu and reported "the menu
 * is gone", which was true. The menu is a property menu, so it needs a
 * property to point at: the current property when the caller knows it is not
 * knowable here, so the FIRST property anchors the links. For the single-
 * property organizations this product is built around, that is simply "the
 * hotel"; with several, it is a reasonable place for Inventory to lead.
 *
 * An organization with no properties at all still gets the header — the menu
 * is simply absent, because there is nowhere for it to point.
 */
export async function OrgShell({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('nav');
  const [properties, me] = await Promise.all([api.properties(), api.me()]);
  const anchor = properties[0];

  const items = anchor
    ? [
        { href: `/properties/${anchor.id}/inventory`, label: t('inventory') },
        { href: `/properties/${anchor.id}/reservations`, label: t('reservations') },
        { href: `/properties/${anchor.id}/stay-view`, label: t('stayView') },
        { href: `/properties/${anchor.id}/room-types`, label: t('roomTypes') },
        { href: `/properties/${anchor.id}/rate-plans`, label: t('ratePlans') },
        { href: `/properties/${anchor.id}/rooms`, label: t('rooms') },
        { href: `/properties/${anchor.id}/guests`, label: t('guests') },
        { href: `/properties/${anchor.id}/channels`, label: t('channels') },
        { href: `/properties/${anchor.id}/reports`, label: t('reports') },
        { href: `/properties/${anchor.id}/notifications`, label: t('notifications') },
        { href: `/properties/${anchor.id}/audit`, label: t('audit') },
        { href: '/team', label: t('team') },
      ]
    : [];

  return (
    <div className="min-h-screen">
      <header className="bg-ink-900">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-6 py-3">
          <Link href="/" aria-label="DeeHub">
            <Wordmark tone="light" />
          </Link>

          {anchor && (
            <>
              <span aria-hidden className="h-6 w-px shrink-0 bg-white/15" />
              <PropertySwitcher
                properties={properties.map((property) => ({
                  id: property.id,
                  name: property.name,
                }))}
                currentId={anchor.id}
              />
            </>
          )}

          <div className="ml-auto flex items-center gap-3 text-sm">
            {/* Visible on every width: on a phone this link is the only path
                to changing your own password. */}
            <Link
              href="/account"
              className="max-w-[38vw] truncate text-stone-300 transition hover:text-white"
            >
              {me.email}
            </Link>
            <LocaleSwitcher />
            <SignOutButton label={t('signOut')} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px] flex-col items-stretch gap-6 px-6 py-6 lg:flex-row lg:items-start">
        {items.length > 0 && <MainNav items={items} />}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
