import { Suspense } from 'react';
import { LoginForm } from '@/components/login-form';

/**
 * Server shell around the client form.
 *
 * The form reads `?next=` via useSearchParams, which forces a client bailout
 * during prerendering unless it sits behind a Suspense boundary. Keeping the
 * page itself a server component means the shell still renders statically.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="h-64 w-full max-w-sm animate-pulse rounded-xl bg-white" />
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
