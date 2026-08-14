import { OrgShell } from '@/components/org-shell';
import { ChangePasswordForm } from '@/components/change-password-form';

/**
 * Account settings.
 *
 * Organization-level rather than property-level — an account is owned by a
 * user — but it wears the same chrome as every other screen (OrgShell): the
 * pilot's first real user could not find this page at all, because its only
 * entry was an email link the property header hid on phones.
 */
export default function AccountPage() {
  return (
    <OrgShell>
      <ChangePasswordForm />
    </OrgShell>
  );
}
