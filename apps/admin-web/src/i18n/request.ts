import { getRequestConfig } from 'next-intl/server';
import messages from '../messages/en.json';

/**
 * i18n is wired from day one (ADR-0003) even though only English exists.
 *
 * Adding Thai is then a locale file plus a locale-negotiation change, not a
 * refactor of every component — which is precisely the retrofit the ADR exists
 * to avoid.
 */
export default getRequestConfig(() => {
  return {
    locale: 'en',
    messages,
    timeZone: 'Asia/Bangkok',
  };
});
