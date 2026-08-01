import { Suspense } from 'react';
import { ResetPasswordForm } from '@/components/reset-password-form';

/**
 * Server shell around the client form.
 *
 * The token is read from the query string with useSearchParams, which forces a
 * client bailout during prerendering unless it sits behind a Suspense boundary.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="h-64 w-full max-w-sm animate-pulse rounded-xl bg-white" />
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
