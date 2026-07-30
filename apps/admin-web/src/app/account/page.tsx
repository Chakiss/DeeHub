import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { Wordmark } from '@/components/wordmark';
import { ChangePasswordForm } from '@/components/change-password-form';

/**
 * Account settings.
 *
 * Outside the property layout on purpose: an account is owned by a user, not by
 * a property, and the first thing a new owner does — change the password they
 * were handed — happens before they have chosen one.
 */
export default async function AccountPage() {
  const [t, me] = await Promise.all([getTranslations('nav'), api.me()]);

  return (
    <div className="min-h-screen">
      <header className="bg-ink-900">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-3">
          <Link href="/" aria-label="DeeHub">
            <Wordmark tone="light" />
          </Link>
          <div className="ml-auto text-sm text-slate-300">{me.email}</div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <ChangePasswordForm />
      </main>
    </div>
  );
}
