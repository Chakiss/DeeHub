import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { SignOutButton } from '@/components/sign-out-button';
import { PropertySwitcher } from '@/components/property-switcher';

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

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-3">
          <Link href="/" className="text-base font-semibold tracking-tight text-slate-900">
            DeeHub
          </Link>

          <PropertySwitcher
            properties={properties.map((property) => ({ id: property.id, name: property.name }))}
            currentId={propertyId}
          />

          <nav className="flex items-center gap-1 text-sm">
            <NavLink href={`/properties/${propertyId}/inventory`}>{t('inventory')}</NavLink>
            <NavLink href={`/properties/${propertyId}/reservations`}>{t('reservations')}</NavLink>
            <NavLink href={`/properties/${propertyId}/stay-view`}>{t('stayView')}</NavLink>
            <NavLink href={`/properties/${propertyId}/room-types`}>{t('roomTypes')}</NavLink>
            <NavLink href={`/properties/${propertyId}/rate-plans`}>{t('ratePlans')}</NavLink>
            <NavLink href={`/properties/${propertyId}/rooms`}>{t('rooms')}</NavLink>
            <NavLink href="/team">{t('team')}</NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link
              href="/account"
              className="hidden text-slate-500 transition hover:text-slate-900 sm:inline"
            >
              {me.email}
            </Link>
            <SignOutButton label={t('signOut')} />
          </div>
        </div>
      </header>

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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
    >
      {children}
    </Link>
  );
}
