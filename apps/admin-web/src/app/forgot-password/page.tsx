import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { ForgotPasswordForm } from '@/components/forgot-password-form';
import { LAST_ACCOUNT_COOKIE, decodeLastAccount } from '@/lib/session-config';

/**
 * Server shell around the client form, matching the login page.
 *
 * The last-used account is offered back as a starting point for the same reason
 * it is on the sign-in screen: the organization slug is a value the product
 * chose and nobody memorises, and asking a locked-out person to remember one
 * more thing is how a recovery flow turns into a phone call.
 */
export default async function ForgotPasswordPage() {
  const store = await cookies();
  const lastAccount = decodeLastAccount(store.get(LAST_ACCOUNT_COOKIE)?.value);

  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="h-64 w-full max-w-sm animate-pulse rounded-xl bg-white" />
        </main>
      }
    >
      <ForgotPasswordForm
        initialSlug={lastAccount?.organizationSlug ?? ''}
        initialEmail={lastAccount?.email ?? ''}
      />
    </Suspense>
  );
}
