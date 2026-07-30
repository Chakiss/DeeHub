import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import en from '../messages/en.json';
import th from '../messages/th.json';
import { LOCALE_COOKIE, parseLocale, type Locale } from './locale';

/**
 * i18n was wired from day one (ADR-0003) even when only English existed.
 *
 * That bet paid: adding Thai was a locale file and this negotiation, not a
 * refactor of every component — exactly the retrofit the ADR exists to avoid.
 */
const MESSAGES: Record<Locale, typeof en> = { en, th };

export default getRequestConfig(async () => {
  // A cookie, not the Accept-Language header. Hotel staff share machines and
  // browsers arrive with whatever the last person or the OS chose; an explicit
  // switch is the only signal that reflects what THIS person wants.
  const store = await cookies();
  const locale = parseLocale(store.get(LOCALE_COOKIE)?.value);

  return {
    locale,
    messages: MESSAGES[locale],
    // Always the property's region: dates in this product are hotel nights,
    // not the reader's wall clock (ADR-0003).
    timeZone: 'Asia/Bangkok',
  };
});
