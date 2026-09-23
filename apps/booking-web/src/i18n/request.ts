import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import en from '../messages/en.json';
import th from '../messages/th.json';
import { DEFAULT_LOCALE, LOCALE_COOKIE, parseLocale, type Locale } from './locale';

const MESSAGES: Record<Locale, typeof en> = { en, th };

/**
 * Which language a guest reads.
 *
 * In order: the `lang` a link carried (Google fills `(USER-LANGUAGE)` into
 * the landing URL, and the middleware turns it into the cookie), the cookie,
 * then the browser's own preference, then Thai. A stranger never chose a
 * language in a settings screen; the page has to guess well and offer a
 * switch.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const fromCookie = parseLocale(store.get(LOCALE_COOKIE)?.value);
  const accept = (await headers()).get('accept-language') ?? '';
  const fromBrowser: Locale | null = /^\s*th|,\s*th/i.test(accept)
    ? 'th'
    : /^\s*en|,\s*en/i.test(accept)
      ? 'en'
      : null;
  const locale = fromCookie ?? fromBrowser ?? DEFAULT_LOCALE;

  return {
    locale,
    messages: MESSAGES[locale],
    // Always the property's region: dates are hotel nights (ADR-0003).
    timeZone: 'Asia/Bangkok',
  };
});
