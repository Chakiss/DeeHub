import 'server-only';

/**
 * The public booking API, as this site consumes it.
 *
 * Server-only on purpose: every call is made from a server component or a
 * server action, never from the browser. The browser therefore never learns
 * the API's address and never calls it directly, which keeps rate limiting
 * at one edge (this site's) and lets the API's CORS list stay short.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export function apiBaseUrl(): string {
  return process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';
}

async function request<T>(
  path: string,
  init: RequestInit & { revalidate?: number } = {},
): Promise<T> {
  const { revalidate, ...rest } = init;
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...rest.headers },
    // Prices and availability change by the minute; the catalogue can sit a
    // little, and does, so a page under Google's crawler is not a database hit.
    ...(revalidate === undefined ? { cache: 'no-store' as const } : { next: { revalidate } }),
  });
  const body = (await response.json().catch(() => ({}))) as ErrorBody & T;
  if (!response.ok) {
    const error = body.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed with ${String(response.status)}`,
      error?.details,
    );
  }
  return body;
}

// --- Types mirroring api-spec.md §6.8b ----------------------------------------

export interface Photo {
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export interface CatalogRatePlan {
  ratePlanId: string;
  code: string;
  name: string;
  mealPlan: string;
  isRefundable: boolean;
}

export interface CatalogRoomType {
  roomTypeId: string;
  code: string;
  name: string;
  descriptionEn: string | null;
  descriptionTh: string | null;
  bedConfig: string | null;
  sizeSqm: number | null;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  photos: Photo[];
  ratePlans: CatalogRatePlan[];
}

export type PaymentMethod = 'CARD' | 'PROMPTPAY';

export interface Catalog {
  name: string;
  currency: string;
  timezone: string;
  country: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    postalCode: string | null;
  };
  latitude: number | null;
  longitude: number | null;
  descriptionEn: string | null;
  descriptionTh: string | null;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  tax: { vatPercent: number; serviceChargePercent: number; pricesIncludeTax: boolean };
  photos: Photo[];
  roomTypes: CatalogRoomType[];
  paymentAvailable: boolean;
  paymentMethods: PaymentMethod[];
}

export interface Breakdown {
  subtotal: number;
  serviceCharge: number;
  tax: number;
  total: number;
}

export interface AvailableRatePlan {
  ratePlanId: string;
  name: string;
  mealPlan: string;
  isRefundable: boolean;
  total: number;
  perNight: { date: string; amount: number }[];
  breakdown: Breakdown;
}

export interface AvailableRoomType {
  roomTypeId: string;
  name: string;
  maxAdults: number;
  maxChildren: number;
  availableUnits: number;
  fromTotal: number;
  ratePlans: AvailableRatePlan[];
}

export interface Availability {
  checkIn: string;
  checkOut: string;
  nights: number;
  currency: string;
  roomTypes: AvailableRoomType[];
}

export interface LowestNight {
  date: string;
  fromTotalMinor: number | null;
}

export interface CreateBookingInput {
  guest: { name: string; email: string; phone?: string };
  checkIn: string;
  checkOut: string;
  stays: { roomTypeId: string; ratePlanId: string; adults: number; children: number }[];
  specialRequests?: string;
}

export interface CreatedBooking {
  code: string;
  status: string;
  currency: string;
  total: number;
  holdExpiresInSeconds: number;
  paymentAvailable: boolean;
  paymentMethods: PaymentMethod[];
}

export interface Booking {
  code: string;
  status: string;
  currency: string;
  bookerName: string;
  checkIn: string;
  checkOut: string;
  subtotal: number;
  serviceCharge: number;
  tax: number;
  total: number;
  holdExpiresAt: string | null;
  createdAt: string;
  stays: {
    roomTypeName: string;
    adults: number;
    children: number;
    nights: { date: string; amountMinor: number }[];
  }[];
  payment: { intentId: string; method: string; status: string } | null;
}

export type StartPaymentResult =
  | { status: 'PAID'; intentId: string; reservationStatus: string }
  | {
      status: 'PENDING';
      intentId: string;
      method: PaymentMethod;
      authorizeUri: string | null;
      qrImageUri: string | null;
      expiresAt: string | null;
    }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DECLINED'; reason: string; retryable: boolean };

export interface PaymentStatus {
  intentId: string;
  method: PaymentMethod;
  outcome: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'PAID_UNCONFIRMABLE';
  reason?: string;
  authorizeUri: string | null;
  qrImageUri: string | null;
  expiresAt: string | null;
  reservationStatus: string;
}

const base = (org: string, code: string) =>
  `/public/${encodeURIComponent(org)}/${encodeURIComponent(code)}`;

export const api = {
  catalog: (org: string, code: string) => request<Catalog>(base(org, code), { revalidate: 60 }),

  lowest: (org: string, code: string, from: string, to: string) =>
    request<{ currency: string; nights: LowestNight[] }>(
      `${base(org, code)}/lowest?from=${from}&to=${to}`,
    ),

  availability: (
    org: string,
    code: string,
    query: { checkIn: string; checkOut: string; adults: number; children: number },
  ) =>
    request<Availability>(
      `${base(org, code)}/availability?checkIn=${query.checkIn}&checkOut=${query.checkOut}&adults=${String(query.adults)}&children=${String(query.children)}`,
    ),

  createBooking: (org: string, code: string, input: CreateBookingInput) =>
    request<CreatedBooking>(`${base(org, code)}/bookings`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  booking: (org: string, code: string, bookingCode: string, email: string) =>
    request<Booking>(
      `${base(org, code)}/bookings/${encodeURIComponent(bookingCode)}?email=${encodeURIComponent(email)}`,
    ),

  startPayment: (
    org: string,
    code: string,
    bookingCode: string,
    input: { method: PaymentMethod; token?: string; returnUri: string },
  ) =>
    request<StartPaymentResult>(
      `${base(org, code)}/bookings/${encodeURIComponent(bookingCode)}/payments`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),

  paymentStatus: (
    org: string,
    code: string,
    bookingCode: string,
    intentId: string,
    email: string,
  ) =>
    request<PaymentStatus>(
      `${base(org, code)}/bookings/${encodeURIComponent(bookingCode)}/payments/${encodeURIComponent(intentId)}?email=${encodeURIComponent(email)}`,
    ),
};
