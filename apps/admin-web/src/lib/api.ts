import 'server-only';
import { apiBaseUrl, getAccessToken } from './session';

/**
 * Typed client for the DeeHub API.
 *
 * Hand-written for now. architecture.md §8 calls for a client generated from
 * the OpenAPI document with a CI drift check; that is deferred until the
 * endpoint surface settles, and the deviation is recorded in the README so it
 * does not quietly become permanent.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    // Inventory and reservations change constantly; a cached grid showing rooms
    // that are already sold is worse than a slightly slower page.
    cache: 'no-store',
  });

  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => ({}))) as ErrorBody & T;

  if (!response.ok) {
    const error = body.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed with ${String(response.status)}`,
      error?.details,
      error?.requestId,
    );
  }

  return body;
}

// --- Types mirroring the API contract ---------------------------------------

export interface Money {
  amount: number;
  currency: string;
}

export interface InventoryDay {
  date: string;
  allotment: number;
  booked: number;
  available: number;
  stopSell: boolean;
  minStay: number;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  open: boolean;
}

export interface InventoryRow {
  roomTypeId: string;
  code: string;
  name: string;
  days: InventoryDay[];
}

export interface InventoryGrid {
  from: string;
  to: string;
  roomTypes: InventoryRow[];
}

export interface ReservationListItem {
  id: string;
  code: string;
  status: string;
  source: string;
  bookerName: string;
  checkIn: string | null;
  checkOut: string | null;
  nights: number;
  rooms: number;
  total: Money;
  createdAt: string;
}

export interface ReservationList {
  items: ReservationListItem[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface ReservationDetail {
  id: string;
  code: string;
  propertyId: string;
  status: string;
  version: number;
  currency: string;
  total: Money;
  stays: {
    id: string;
    roomTypeId: string;
    checkIn: string;
    checkOut: string;
    nights: string[];
  }[];
}

export interface InventoryUpdate {
  roomTypeId: string;
  from: string;
  to: string;
  daysOfWeek?: string[];
  allotment?: number;
  stopSell?: boolean;
  minStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
}

// --- Endpoints ---------------------------------------------------------------

export const api = {
  me: () =>
    request<{
      id: string;
      email: string;
      fullName: string;
      organizationId: string;
      memberships: { role: string; propertyId: string | null }[];
      capabilities: string[];
    }>('/auth/me'),

  properties: () =>
    request<{ id: string; code: string; name: string; timezone: string; currency: string }[]>(
      '/properties',
    ),

  inventoryGrid: (propertyId: string, from: string, to: string) =>
    request<InventoryGrid>(`/properties/${propertyId}/inventory?from=${from}&to=${to}`),

  updateInventory: (propertyId: string, updates: InventoryUpdate[]) =>
    request<{ nightsUpdated: number; roomTypesTouched: number }>(
      `/properties/${propertyId}/inventory`,
      { method: 'PATCH', body: JSON.stringify({ updates }) },
    ),

  reservations: (propertyId: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    return request<ReservationList>(
      `/properties/${propertyId}/reservations${query ? `?${query}` : ''}`,
    );
  },

  reservation: (propertyId: string, id: string) =>
    request<ReservationDetail>(`/properties/${propertyId}/reservations/${id}`),

  cancelReservation: (propertyId: string, id: string, version: number, reason?: string) =>
    request<{ id: string; status: string; releasedNights: string[]; retainedNights: string[] }>(
      `/properties/${propertyId}/reservations/${id}/cancel`,
      { method: 'POST', body: JSON.stringify({ version, ...(reason ? { reason } : {}) }) },
    ),
};
