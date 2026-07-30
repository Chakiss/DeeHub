import 'server-only';
import { apiBaseUrl, getAccessToken } from './session';
import type { MealPlan } from './meal-plans';

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
  /**
   * Lowest active price at standard occupancy, or null when the night has no
   * price at all. Null with allotment means the night cannot actually be sold.
   */
  rate: { amountMinor: number; currency: string; planCount: number } | null;
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

export interface RoomType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  standardOccupancy: number;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  sortOrder: number;
  isActive: boolean;
}

export interface CreateRoomTypeInput {
  code: string;
  name: string;
  description?: string | null;
  standardOccupancy: number;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
}

/** Every field optional: this is a PATCH, and `code` is deliberately absent. */
export type UpdateRoomTypeInput = Partial<Omit<CreateRoomTypeInput, 'code'>> & {
  sortOrder?: number;
  isActive?: boolean;
};

export interface RatePlan {
  id: string;
  roomTypeId: string;
  code: string;
  name: string;
  mealPlan: string;
  isRefundable: boolean;
  isActive: boolean;
}

export interface CreateRatePlanInput {
  roomTypeId: string;
  code: string;
  name: string;
  mealPlan: MealPlan;
  isRefundable: boolean;
}

/** Neither code nor roomTypeId: both are fixed once the plan exists. */
export interface UpdateRatePlanInput {
  name?: string;
  mealPlan?: MealPlan;
  isRefundable?: boolean;
  isActive?: boolean;
}

export interface RateUpdate {
  ratePlanId: string;
  from: string;
  to: string;
  daysOfWeek?: string[];
  /** One entry per occupancy; amounts are integer minor units (ADR-0003). */
  prices: { occupancy: number; amount: number }[];
}

export interface OrganizationUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  lastLoginAt: string | null;
  memberships: { role: string; propertyId: string | null }[];
}

/** Only ever present on the invite response — never stored, never re-fetchable. */
export interface InvitedUser extends OrganizationUser {
  temporaryPassword: string;
}

export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'] as const;

export interface Room {
  id: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  housekeepingStatus: string;
  notes: string | null;
  isActive: boolean;
}

export interface StayViewOccupancy {
  stayId: string;
  reservationId: string;
  reservationCode: string;
  guestName: string | null;
  status: string;
  /** Check-in and check-out take an expected version (optimistic locking). */
  version: number;
  checkIn: string;
  checkOut: string;
  upgraded: boolean;
}

export interface StayViewRoom {
  roomId: string;
  roomNumber: string;
  floor: string | null;
  roomTypeId: string;
  roomTypeName: string;
  housekeepingStatus: string;
  isActive: boolean;
  stays: StayViewOccupancy[];
}

export interface StayView {
  from: string;
  to: string;
  dates: string[];
  rooms: StayViewRoom[];
  unassigned: (StayViewOccupancy & { roomTypeId: string; roomTypeName: string })[];
}

export interface PerformanceNight {
  date: string;
  roomsSold: number;
  revenueMinor: number;
  allotment: number;
  adrMinor: number | null;
  sellThrough: number | null;
  occupancy: number | null;
  revParMinor: number | null;
}

export interface Performance {
  from: string;
  to: string;
  currency: string;
  /** Null when no physical rooms are set up — occupancy is then unanswerable. */
  roomsAvailable: number | null;
  nights: PerformanceNight[];
  totals: {
    roomsSold: number;
    revenueMinor: number;
    allotment: number;
    adrMinor: number | null;
    sellThrough: number | null;
    occupancy: number | null;
    revParMinor: number | null;
  };
}

export interface Guest {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  notes: string | null;
  stays: number;
  lastStay: string | null;
  revenueMinor: number;
  /** Other profiles sharing this email — a merge queue, not a merge. */
  possibleDuplicates: number;
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

  users: () => request<{ items: OrganizationUser[] }>('/users').then((body) => body.items),

  inviteUser: (input: { email: string; fullName: string; role: string }) =>
    request<InvitedUser>('/users', { method: 'POST', body: JSON.stringify(input) }),

  updateUser: (
    userId: string,
    input: { fullName?: string; role?: string; status?: 'ACTIVE' | 'DISABLED' },
  ) =>
    request<OrganizationUser>(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(input) }),

  resetUserPassword: (userId: string) =>
    request<{ email: string; fullName: string; temporaryPassword: string }>(
      `/users/${userId}/reset-password`,
      { method: 'POST' },
    ),

  properties: () =>
    request<{ id: string; code: string; name: string; timezone: string; currency: string }[]>(
      '/properties',
    ),

  roomTypes: (propertyId: string) =>
    request<{ items: RoomType[] }>(`/properties/${propertyId}/room-types`).then(
      (body) => body.items,
    ),

  createRoomType: (propertyId: string, input: CreateRoomTypeInput) =>
    request<RoomType>(`/properties/${propertyId}/room-types`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateRoomType: (propertyId: string, roomTypeId: string, input: UpdateRoomTypeInput) =>
    request<RoomType>(`/properties/${propertyId}/room-types/${roomTypeId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  ratePlans: (propertyId: string) =>
    request<{ items: RatePlan[] }>(`/properties/${propertyId}/rate-plans`).then(
      (body) => body.items,
    ),

  createRatePlan: (propertyId: string, input: CreateRatePlanInput) =>
    request<RatePlan>(`/properties/${propertyId}/rate-plans`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateRatePlan: (propertyId: string, ratePlanId: string, input: UpdateRatePlanInput) =>
    request<RatePlan>(`/properties/${propertyId}/rate-plans/${ratePlanId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  updateRates: (propertyId: string, updates: RateUpdate[]) =>
    request<{ nightsUpdated: number }>(`/properties/${propertyId}/rates`, {
      method: 'PATCH',
      body: JSON.stringify({ updates }),
    }),

  rooms: (propertyId: string) =>
    request<{ items: Room[] }>(`/properties/${propertyId}/rooms`).then((body) => body.items),

  createRoom: (
    propertyId: string,
    input: { roomTypeId: string; roomNumber: string; floor?: string | null },
  ) =>
    request<Room>(`/properties/${propertyId}/rooms`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateRoom: (
    propertyId: string,
    roomId: string,
    input: {
      roomNumber?: string;
      floor?: string | null;
      housekeepingStatus?: string;
      isActive?: boolean;
    },
  ) =>
    request<Room>(`/properties/${propertyId}/rooms/${roomId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  assignRoom: (propertyId: string, stayId: string, roomId: string | null) =>
    request<{ assignedRoomId: string | null }>(`/properties/${propertyId}/stays/${stayId}/room`, {
      method: 'PATCH',
      body: JSON.stringify({ roomId }),
    }),

  checkIn: (propertyId: string, reservationId: string, version: number) =>
    request<{ id: string; status: string; rooms: string[] }>(
      `/properties/${propertyId}/reservations/${reservationId}/check-in`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),

  checkOut: (propertyId: string, reservationId: string, version: number) =>
    request<{ id: string; status: string; roomsToClean: string[] }>(
      `/properties/${propertyId}/reservations/${reservationId}/check-out`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),

  guests: (propertyId: string, q?: string) =>
    request<{ items: Guest[] }>(
      `/properties/${propertyId}/guests${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ).then((body) => body.items),

  performance: (propertyId: string, from: string, to: string) =>
    request<Performance>(`/properties/${propertyId}/reports/performance?from=${from}&to=${to}`),

  stayView: (propertyId: string, from: string, to: string) =>
    request<StayView>(`/properties/${propertyId}/stay-view?from=${from}&to=${to}`),

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
