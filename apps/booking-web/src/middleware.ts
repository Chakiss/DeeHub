import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALE_MAX_AGE, parseLocale } from '@/i18n/locale';

/**
 * `?lang=th` on any URL becomes the locale cookie and disappears from the
 * address bar. Google's landing-page template fills `(USER-LANGUAGE)` into
 * that parameter, so a traveller who searched in English lands in English.
 */
export function middleware(request: NextRequest): NextResponse {
  const url = request.nextUrl;
  const lang = parseLocale(url.searchParams.get('lang'));
  if (!lang) return NextResponse.next();

  url.searchParams.delete('lang');
  const response = NextResponse.redirect(url);
  response.cookies.set(LOCALE_COOKIE, lang, {
    path: '/',
    maxAge: LOCALE_MAX_AGE,
    sameSite: 'lax',
  });
  return response;
}

export const config = {
  matcher: ['/((?!_next|fonts|favicon.ico).*)'],
};
