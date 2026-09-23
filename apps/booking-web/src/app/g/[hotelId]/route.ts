import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl } from '@/lib/api';

/**
 * Where Google's booking link lands.
 *
 * The landing-page template in Hotel Center (docs/google/landing-pages.xml)
 * points every property at this one route with the hotel id and the
 * itinerary as query parameters; this turns the id into the hotel's own
 * address and forwards the itinerary. One template for every hotel, so a
 * new property needs nothing uploaded to Google.
 *
 * Unknown id → the company site: the link was minted from our feed, so an
 * unknown id means the property has since been closed.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ hotelId: string }> }) {
  const { hotelId } = await context.params;
  const incoming = request.nextUrl.searchParams;

  const response = await fetch(`${apiBaseUrl()}/public/resolve/${encodeURIComponent(hotelId)}`, {
    next: { revalidate: 300 },
  }).catch(() => null);
  if (!response?.ok) {
    return NextResponse.redirect(process.env.MARKETING_URL ?? 'https://deehubhotel.com', 302);
  }
  const { organizationSlug, propertyCode } = (await response.json()) as {
    organizationSlug: string;
    propertyCode: string;
  };

  const target = new URL(`/${organizationSlug}/${propertyCode}/rooms`, request.nextUrl.origin);
  for (const key of [
    'checkin',
    'checkout',
    'nights',
    'adults',
    'children',
    'lang',
    'rate',
    'room',
    'src',
  ]) {
    const value = incoming.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return NextResponse.redirect(target, 302);
}
