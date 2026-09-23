import { notFound } from 'next/navigation';
import { api, ApiError, type Catalog } from './api';

/** The catalogue, or a 404 page: a wrong slug is not an error, it is a wrong address. */
export async function loadHotel(org: string, code: string): Promise<Catalog> {
  try {
    return await api.catalog(org, code);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

export function description(catalog: Catalog, locale: string): string | null {
  return locale === 'th'
    ? (catalog.descriptionTh ?? catalog.descriptionEn)
    : (catalog.descriptionEn ?? catalog.descriptionTh);
}

export function roomDescription(
  room: { descriptionEn: string | null; descriptionTh: string | null },
  locale: string,
): string | null {
  return locale === 'th'
    ? (room.descriptionTh ?? room.descriptionEn)
    : (room.descriptionEn ?? room.descriptionTh);
}

export function mapsLink(catalog: Catalog): string | null {
  if (catalog.latitude === null || catalog.longitude === null) return null;
  return `https://www.google.com/maps?q=${String(catalog.latitude)},${String(catalog.longitude)}`;
}

/** "14:00:00" from Postgres → "14:00". */
export function clock(time: string): string {
  return time.slice(0, 5);
}
