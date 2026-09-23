'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from '@/lib/api';
import { LOCALE_COOKIE, LOCALE_MAX_AGE, parseLocale, type Locale } from '@/i18n/locale';

export interface PreferenceResult {
  readonly ok: boolean;
  readonly locale?: Locale;
  readonly error?: { code: string; message: string };
}

/**
 * The language this person reads the dashboard in.
 *
 * Saved on the account, so it follows them to the next machine they sign in
 * on — and applied to this browser at once, through the same cookie the
 * header switch writes, so nothing changes about how the page picks a
 * language. The header switch is still there for a one-off look at the
 * other language on a shared machine; this is the default it starts from.
 */
export async function setPreferredLocale(value: string): Promise<PreferenceResult> {
  const locale = parseLocale(value);
  try {
    await api.setPreferredLocale(locale);
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: LOCALE_MAX_AGE,
  });
  revalidatePath('/', 'layout');
  return { ok: true, locale };
}
