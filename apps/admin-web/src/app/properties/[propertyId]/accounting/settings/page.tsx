import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { api } from '@/lib/api';
import { AccountingSettingsForm } from '@/components/accounting-settings-form';

/**
 * The answers a new customer gives at sign-up, and can correct afterwards.
 *
 * Guarded by `accounting:settings`, which only OWNER and ADMIN hold — the tax
 * identity is not a property manager's business, and changing it silently
 * changes every figure the module produces.
 */
export default async function AccountingSettingsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const [t, settings] = await Promise.all([
    getTranslations('accounting'),
    api.accountingSettings(propertyId),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/properties/${propertyId}/accounting`}
          className="text-sm text-brand-600 hover:text-brand-700"
        >
          ← {t('title')}
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-900">{t('settings')}</h1>
        <p className="text-sm text-stone-500">{t('settingsSubtitle')}</p>
      </div>

      <AccountingSettingsForm propertyId={propertyId} settings={settings} />
    </div>
  );
}
