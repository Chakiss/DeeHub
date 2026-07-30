import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { LoginForm } from '@/components/login-form';
import { LAST_ACCOUNT_COOKIE, decodeLastAccount } from '@/lib/session-config';

/**
 * Server shell around the client form.
 *
 * The form reads `?next=` via useSearchParams, which forces a client bailout
 * during prerendering unless it sits behind a Suspense boundary. Keeping the
 * page itself a server component means the shell still renders statically.
 */
export default async function LoginPage() {
  // Read on the server: the cookie is httpOnly, so client JavaScript cannot see
  // it — an XSS bug should not be able to lift a colleague's address.
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
      <LoginForm lastAccount={lastAccount} />
    </Suspense>
  );
}
