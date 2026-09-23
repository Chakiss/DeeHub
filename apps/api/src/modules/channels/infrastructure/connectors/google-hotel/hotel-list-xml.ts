import { attrs, esc } from './xml';

export interface HotelListing {
  readonly id: string;
  readonly name: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly phone: string | null;
}

/**
 * Google's Hotel List Feed: the properties this partner speaks for, with
 * enough address to match each to its Google Maps listing. `<id>` is the
 * property's uuid — the same value every ARI message names as HotelCode and
 * the landing-page template receives as PARTNER-HOTEL-ID.
 */
export function buildHotelList(listings: readonly HotelListing[], language = 'en'): string {
  const items = listings
    .map((hotel) => {
      const components = [
        ['addr1', hotel.addressLine1],
        ['addr2', hotel.addressLine2],
        ['city', hotel.city],
        ['postal_code', hotel.postalCode],
      ]
        .filter(([, value]) => value)
        .map(
          ([name, value]) =>
            `<component${attrs({ name: name as string })}>${esc(value as string)}</component>`,
        )
        .join('');
      return (
        `<listing>` +
        `<id>${esc(hotel.id)}</id>` +
        `<name>${esc(hotel.name)}</name>` +
        `<address${attrs({ format: 'simple' })}>${components}</address>` +
        `<country>${esc(hotel.country)}</country>` +
        (hotel.latitude !== null ? `<latitude>${esc(hotel.latitude)}</latitude>` : '') +
        (hotel.longitude !== null ? `<longitude>${esc(hotel.longitude)}</longitude>` : '') +
        (hotel.phone ? `<phone${attrs({ type: 'main' })}>${esc(hotel.phone)}</phone>` : '') +
        `<category>hotel</category>` +
        `</listing>`
      );
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<listings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.gstatic.com/localfeed/local_feed.xsd">` +
    `<language>${esc(language)}</language>` +
    items +
    `</listings>`
  );
}
