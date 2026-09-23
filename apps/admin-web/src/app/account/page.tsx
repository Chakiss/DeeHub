import { getLocale } from 'next-intl/server';
import { api } from '@/lib/api';
import { parseLocale } from '@/i18n/locale';
import { OrgShell } from '@/components/org-shell';
import { ChangePasswordForm } from '@/components/change-password-form';
import { LanguagePreferenceForm } from '@/components/language-preference-form';

/**
 * Account settings.
 *
 * Organization-level rather than property-level — an account is owned by a
 * user — but it wears the same chrome as every other screen (OrgShell): the
 * pilot's first real user could not find this page at all, because its only
 * entry was an email link the property header hid on phones.
 */
export default async function AccountPage() {
  const [me, locale] = await Promise.all([api.me(), getLocale()]);
  // What the account says; failing that, what this browser is showing.
  const current = me.preferredLocale ? parseLocale(me.preferredLocale) : parseLocale(locale);

  return (
    <OrgShell>
      <div className="space-y-5">
        <LanguagePreferenceForm current={current} />
        <ChangePasswordForm />
      </div>
    </OrgShell>
  );
}
