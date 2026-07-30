import { NextResponse } from 'next/server';
import { LOCALE_COOKIE, LOCALE_MAX_AGE, parseLocale } from '@/i18n/locale';

/**
 * Remember the chosen language.
 *
 * Deliberately reachable WITHOUT signing in: the sign-in page is the first
 * thing a Thai receptionist sees, and being unable to read it until after
 * logging in defeats the point. It stores a language name and nothing else.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { locale?: unknown };
  const locale = parseLocale(typeof body.locale === 'string' ? body.locale : undefined);

  const response = NextResponse.json({ locale });
  response.cookies.set(LOCALE_COOKIE, locale, {
    // Not httpOnly on purpose: it is a display preference, not a credential,
    // and nothing is protected by keeping it out of client JavaScript.
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: LOCALE_MAX_AGE,
  });
  return response;
}
