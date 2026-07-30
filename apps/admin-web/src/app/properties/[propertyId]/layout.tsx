import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { SignOutButton } from '@/components/sign-out-button';
import { PropertySwitcher } from '@/components/property-switcher';
import { MainNav } from '@/components/main-nav';
import { Wordmark } from '@/components/wordmark';
import { LocaleSwitcher } from '@/components/locale-switcher';

export default async function PropertyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const t = await getTranslations('nav');
  const [properties, me] = await Promise.all([api.properties(), api.me()]);
  const current = properties.find((property) => property.id === propertyId);

  const items = [
    { href: `/properties/${propertyId}/inventory`, label: t('inventory') },
    { href: `/properties/${propertyId}/reservations`, label: t('reservations') },
    { href: `/properties/${propertyId}/stay-view`, label: t('stayView') },
    { href: `/properties/${propertyId}/room-types`, label: t('roomTypes') },
    { href: `/properties/${propertyId}/rate-plans`, label: t('ratePlans') },
    { href: `/properties/${propertyId}/rooms`, label: t('rooms') },
    { href: `/properties/${propertyId}/guests`, label: t('guests') },
    { href: `/properties/${propertyId}/reports`, label: t('reports') },
    { href: `/properties/${propertyId}/audit`, label: t('audit') },
    { href: '/team', label: t('team') },
  ];

  return (
    <div className="min-h-screen">
      {/*
       * Two rows, because they answer different questions. The navy strip says
       * WHERE you are — which product, which hotel, who is signed in. The menu
       * below says where you can go. Sharing one row made the hotel's name read
       * as another menu item sitting between "DeeHub" and "Inventory".
       */}
      <header className="bg-ink-900">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-6 py-3">
          <Link href="/" aria-label="DeeHub">
            <Wordmark tone="light" />
          </Link>

          {/* A rule, not just whitespace: it is what stops the hotel name from
              looking like part of the brand lockup. */}
          <span aria-hidden className="h-6 w-px shrink-0 bg-white/15" />

          <PropertySwitcher
            properties={properties.map((property) => ({ id: property.id, name: property.name }))}
            currentId={propertyId}
          />

          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link
              href="/account"
              className="hidden text-slate-300 transition hover:text-white sm:inline"
            >
              {me.email}
            </Link>
            <LocaleSwitcher />
            <SignOutButton label={t('signOut')} />
          </div>
        </div>
      </header>

      <MainNav items={items} />

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {current ? (
          children
        ) : (
          <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
            You do not have access to this property.
          </p>
        )}
      </main>
    </div>
  );
}
