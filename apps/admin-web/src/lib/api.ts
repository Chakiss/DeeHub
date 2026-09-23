import 'server-only';
import { apiBaseUrl, getAccessToken } from './session';
import type { MealPlan } from './meal-plans';
import type { ChannelType } from './channel-types';
import type { FolioChargeKind, FolioPaymentKind, FolioPaymentMethod } from './folio-types';

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

/** How a booking arrived: the category. OTA and TRAVEL_AGENT ones also name which. */
export const RESERVATION_SOURCES = [
  'WALK_IN',
  'PHONE',
  'EMAIL',
  'DIRECT',
  'OTA',
  'TRAVEL_AGENT',
] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

/** An OTA or agent a property takes bookings from — a label, not a connector. */
export interface BookingSource {
  id: string;
  name: string;
  kind: 'OTA' | 'TRAVEL_AGENT';
  channelType: string | null;
  isActive: boolean;
}

export interface ReservationListItem {
  id: string;
  code: string;
  status: string;
  source: string;
  bookingSource: { id: string; name: string } | null;
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
  /** Echoed back on every mutation, for optimistic locking. */
  version: number;
  currency: string;
  source: string;
  bookingSource: { id: string; name: string; kind: string } | null;
  bookerName: string;
  bookerEmail: string | null;
  bookerPhone: string | null;
  specialRequests: string | null;
  createdAt: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  total: Money;
  subtotal: Money;
  tax: Money;
  serviceCharge: Money;
  stays: {
    id: string;
    roomTypeId: string;
    roomTypeName: string;
    ratePlanId: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    guestName: string | null;
    assignedRoomId: string | null;
    assignedRoomNumber: string | null;
    /** Where the frozen prices came from: the plan, the channel, or a typed price. */
    pricedFrom: 'PROPERTY_RATES' | 'CHANNEL' | 'MANUAL';
    priceNote: string | null;
    subtotal: Money;
    /** Frozen prices — what the guest was quoted, not today's rate. */
    nights: { date: string; amount: number }[];
  }[];
}

/** Mirrors the API's create schema (api-spec.md §6.5). One stay = one room unit. */
export interface CreateReservationInput {
  source: ReservationSource;
  /** Which OTA or agent; required by the API for OTA and TRAVEL_AGENT. */
  bookingSourceId?: string;
  status?: 'PENDING' | 'CONFIRMED';
  booker: { name: string; email?: string; phone?: string };
  stays: {
    roomTypeId: string;
    ratePlanId: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    children?: number;
    guestName?: string;
    /** Put this stay in a room now. The API refuses if it is taken. */
    roomId?: string;
    /** A price per night instead of the plan's, in minor units. Needs reservation:price_override. */
    nightlyRate?: number;
    /** Required when nightlyRate is below the plan on a non-OTA booking. */
    priceNote?: string;
  }[];
  specialRequests?: string;
  guestId?: string;
}

/** PATCH: absent means "leave it alone". null on guestName clears it. */
export interface ModifyStayInput {
  version: number;
  roomTypeId?: string;
  ratePlanId?: string;
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  guestName?: string | null;
  reason?: string;
}

export interface ModifiedStay {
  reservationId: string;
  stayId: string;
  version: number;
  releasedNights: string[];
  heldNights: string[];
  /** The guest no longer has a room number: the front desk must reassign. */
  roomAssignmentCleared: boolean;
  total: Money;
}

/** Only the departure date moves. Anything else would be a modification. */
export interface ExtendStayInput {
  version: number;
  checkOut: string;
  reason?: string;
}

export interface ExtendedStay {
  reservationId: string;
  stayId: string;
  version: number;
  checkOut: string;
  addedNights: string[];
  /** What the added nights cost at today's rate, not the whole stay. */
  addedAmount: Money;
  total: Money;
}

/** Only the departure date moves, exactly as with an extension. */
export interface ShortenStayInput {
  version: number;
  checkOut: string;
  reason?: string;
}

export interface ShortenedStay {
  reservationId: string;
  stayId: string;
  version: number;
  checkOut: string;
  releasedNights: string[];
  /** What came off the bill. No early-departure fee is applied — see the API. */
  refundedAmount: Money;
  total: Money;
}

export interface FolioRoomCharge {
  date: string;
  stayId: string;
  roomTypeName: string;
  amount: number;
}

export interface FolioExtraCharge {
  id: string;
  kind: FolioChargeKind;
  description: string | null;
  amount: number;
  taxable: boolean;
  businessDate: string;
  postedAt: string;
  postedBy: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
}

export interface FolioPayment {
  id: string;
  kind: FolioPaymentKind;
  method: FolioPaymentMethod;
  amount: number;
  reference: string | null;
  businessDate: string;
  recordedAt: string;
  recordedBy: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
}

export interface Folio {
  reservationId: string;
  code: string;
  status: string;
  bookerName: string;
  currency: string;
  roomCharges: FolioRoomCharge[];
  extraCharges: FolioExtraCharge[];
  payments: FolioPayment[];
  totals: {
    roomSubtotal: number;
    extrasSubtotal: number;
    serviceCharge: number;
    tax: number;
    untaxedExtras: number;
    chargesTotal: number;
    paid: number;
    refunded: number;
    /** Negative means the hotel owes the guest. */
    balance: number;
  };
}

export interface CreatedReservation {
  id: string;
  code: string;
  status: string;
  propertyId: string;
  currency: string;
  total: Money;
  /** Non-empty when an OTA booking was taken past a stop-sell or an allotment. */
  overbookings: {
    roomTypeId: string;
    dates: string[];
    reason: 'ALLOTMENT_RAISED' | 'RESTRICTION_OVERRIDDEN';
    detail: string;
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

/** One property as the settings page edits it. Tax and currency are read-only here. */
export interface PropertyProfile {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currency: string;
  country: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  descriptionTh: string | null;
  descriptionEn: string | null;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  taxRateBp: number;
  serviceChargeRateBp: number;
  pricesIncludeTax: boolean;
  status: string;
}

export type UpdatePropertyInput = Partial<
  Pick<
    PropertyProfile,
    | 'name'
    | 'addressLine1'
    | 'addressLine2'
    | 'city'
    | 'postalCode'
    | 'phone'
    | 'email'
    | 'website'
    | 'latitude'
    | 'longitude'
    | 'descriptionTh'
    | 'descriptionEn'
    | 'amenities'
    | 'checkInTime'
    | 'checkOutTime'
  >
>;

export const MEDIA_KINDS = ['PROPERTY', 'ROOM_TYPE'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaItem {
  id: string;
  kind: MediaKind;
  roomTypeId: string | null;
  url: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  sortOrder: number;
}

export interface MediaListing {
  items: MediaItem[];
  storageAvailable: boolean;
  limits: { maxBytes: number; maxPerGallery: number };
}

export interface CreateMediaUploadInput {
  kind: MediaKind;
  roomTypeId?: string | null;
  contentType: string;
  bytes: number;
}

export interface MediaUploadGrant {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface AttachMediaInput {
  kind: MediaKind;
  roomTypeId?: string | null;
  mediaId: string;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
}

export interface UpdateMediaInput {
  alt?: string | null;
  sortOrder?: number;
}

export interface RoomType {
  id: string;
  code: string;
  name: string;
  /** English; Thai is `descriptionTh`. */
  description: string | null;
  descriptionTh: string | null;
  bedConfig: string | null;
  sizeSqm: number | null;
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
  descriptionTh?: string | null;
  bedConfig?: string | null;
  sizeSqm?: number | null;
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
  /** Bookable by a stranger on the booking page and metasearch. Off = desk only. */
  sellOnline: boolean;
  isActive: boolean;
  /** Null on a plan that holds its own prices. */
  parentRatePlanId: string | null;
  derivationType: 'PERCENTAGE' | 'AMOUNT' | null;
  /** Signed: basis points for PERCENTAGE, minor units for AMOUNT. */
  derivationValue: number | null;
  /** "−10%", rendered by the API so three clients need not each know the unit. */
  derivationLabel: string | null;
}

export interface CreateRatePlanInput {
  roomTypeId: string;
  code: string;
  name: string;
  mealPlan: MealPlan;
  isRefundable: boolean;
  sellOnline?: boolean;
  /** Present to price this plan as an offset from another. Fixed at creation. */
  derivation?: {
    parentRatePlanId: string;
    type: 'PERCENTAGE' | 'AMOUNT';
    value: number;
  };
}

/**
 * Neither code nor roomTypeId: both are fixed once the plan exists. Nor whether
 * the plan is derived — only the offset itself can move.
 */
export interface UpdateRatePlanInput {
  name?: string;
  mealPlan?: MealPlan;
  isRefundable?: boolean;
  sellOnline?: boolean;
  isActive?: boolean;
  derivationValue?: number;
}

export interface RateUpdate {
  ratePlanId: string;
  from: string;
  to: string;
  daysOfWeek?: string[];
  /** One entry per occupancy; amounts are integer minor units (ADR-0003). */
  prices: { occupancy: number; amount: number }[];
}

/** Removing prices, not setting them to zero: a zero-priced night sells free. */
export interface RateDeletion {
  ratePlanId: string;
  from: string;
  to: string;
  daysOfWeek?: string[];
  /** Absent removes every occupancy on those nights. */
  occupancies?: number[];
}

export interface RateDeletionResult {
  pricesRemoved: number;
  /** Nights that still have allotment but can no longer be sold at all. */
  nightsNowUnsellable: number;
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

/** A room that could take a guest for a range of nights (advisory). */
export interface AssignableRoom {
  roomId: string;
  roomNumber: string;
  floor: string | null;
  roomTypeId: string;
  roomTypeName: string;
  housekeepingStatus: string;
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

export interface PickupNight {
  date: string;
  roomsSold: number;
  revenueMinor: number;
  /** Null when there is no baseline at all — history starts when it starts. */
  baselineRoomsSold: number | null;
  baselineRevenueMinor: number | null;
  pickupRooms: number | null;
  pickupRevenueMinor: number | null;
}

export interface Pickup {
  from: string;
  to: string;
  currency: string;
  asOfRequested: string;
  /** The baseline actually found. Differs from requested when a day is missing. */
  asOfUsed: string | null;
  earliestSnapshot: string | null;
  nights: PickupNight[];
  totals: {
    roomsSold: number;
    revenueMinor: number;
    baselineRoomsSold: number | null;
    baselineRevenueMinor: number | null;
    pickupRooms: number | null;
    pickupRevenueMinor: number | null;
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
  /**
   * Other live profiles sharing an email, a phone or a full name — a merge
   * queue, not a merge. Nothing is folded together without somebody looking.
   */
  possibleDuplicates: number;
}

export type MatchSignal = 'NAME' | 'EMAIL' | 'PHONE';
export type MatchConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

/** A candidate, with why the system thinks so and how much it trusts it. */
export interface DuplicateGuest {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  notes: string | null;
  signals: MatchSignal[];
  confidence: MatchConfidence;
}

export interface MergeGuestResult {
  guest: Guest;
  reservationsMoved: number;
  /** Columns the survivor gained from the duplicate, so the screen can say so. */
  fieldsFilled: string[];
}

export interface ChannelSummary {
  id: string;
  type: string;
  name: string;
  status: string;
  syncHorizonDays: number;
  /** Whether any are stored. The values themselves are never returned. */
  hasCredentials: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  mappedRoomTypes: number;
  totalRoomTypes: number;
  mappedRatePlans: number;
  createdAt: string;
}

export interface ChannelMapping {
  id: string;
  localId: string;
  localName: string;
  localCode: string;
  externalId: string;
  externalName: string | null;
}

export interface ChannelRatePlanMapping extends ChannelMapping {
  /** Markup applied before this plan's price is pushed, in basis points. */
  rateMultiplierBp: number;
}

export interface SyncJobSummary {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface InboundBookingSummary {
  id: string;
  externalReservationId: string;
  status: string;
  error: string | null;
  receivedAt: string;
  reservationId: string | null;
}

export interface ConnectionTest {
  ok: boolean;
  detail: string;
  latencyMs: number;
}

export interface ForceSyncResult {
  from: string;
  to: string;
  nights: number;
  roomTypes: {
    roomTypeId: string;
    accepted: number;
    rejected: number;
    warnings: string[];
    /** Set when that room type failed; the others were still attempted. */
    error: string | null;
  }[];
}

export interface ChannelDetail extends ChannelSummary {
  roomTypeMappings: ChannelMapping[];
  ratePlanMappings: ChannelRatePlanMapping[];
  availableRoomTypes: { id: string; code: string; name: string }[];
  availableRatePlans: { id: string; roomTypeId: string; code: string; name: string }[];
  recentJobs: SyncJobSummary[];
  recentInbound: InboundBookingSummary[];
}

export interface CreateChannelInput {
  type: ChannelType;
  name: string;
  syncHorizonDays?: number;
  credentials?: Record<string, string>;
}

export interface UpdateChannelInput {
  name?: string;
  syncHorizonDays?: number;
  status?: 'ACTIVE' | 'INACTIVE';
  /** Replaces the stored set. Omit to keep what is already there. */
  credentials?: Record<string, string>;
}

export interface MappingInput {
  localId: string;
  externalId: string;
  externalName?: string | null;
}

export interface RatePlanMappingInput extends MappingInput {
  /**
   * Markup for this plan on this channel, in basis points: 10000 sends the
   * direct price unchanged, 18000 sends it at ×1.8.
   */
  rateMultiplierBp?: number;
}

export interface NotificationEntry {
  id: string;
  createdAt: string;
  sentAt: string | null;
  kind: string;
  channel: string;
  audience: string;
  recipient: string;
  locale: string;
  subject: string | null;
  body: string;
  status: string;
  attempts: number;
  lastError: string | null;
  /** Why nothing was sent. Set on a SKIPPED row, never on a SENT one. */
  skippedReason: string | null;
  reservationId: string | null;
  context: { code?: string; checkIn?: string; checkOut?: string } | null;
}

export interface NotificationPage {
  items: NotificationEntry[];
  /** Counts across the whole property, not just this page. */
  summary: Record<string, number>;
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorType: string;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

// --- Endpoints ---------------------------------------------------------------

/* ---------------------------------------------------------------- accounting */

export interface MoneyAmount {
  amount: number;
  currency: string;
}

export interface AccountingSettings {
  propertyId: string;
  taxpayerType: 'INDIVIDUAL' | 'JURISTIC' | null;
  taxId: string | null;
  branchCode: string;
  legalNameTh: string | null;
  legalNameEn: string | null;
  addressTh: string | null;
  vatRegistered: boolean;
  vatRegisteredFrom: string | null;
  withholdingEnabled: boolean;
  localLevyEnabled: boolean;
  localLevyRateBp: number;
  fiscalYearStartMonth: number;
}

export interface ExpenseCategory {
  id: string;
  code: string;
  nameTh: string;
  nameEn: string;
  group: string;
  defaultWhtRateBp: number;
  defaultWhtIncomeType: string | null;
  isDeductible: boolean;
  sortOrder: number;
  isActive: boolean;
}

export interface Vendor {
  id: string;
  name: string;
  taxId: string | null;
  taxpayerType: 'INDIVIDUAL' | 'JURISTIC' | null;
  country: string;
  isForeign: boolean;
  defaultCategoryId: string | null;
  defaultWhtRateBp: number | null;
  isActive: boolean;
}

export interface Expense {
  id: string;
  categoryId: string;
  categoryCode: string;
  categoryNameTh: string;
  categoryNameEn: string;
  categoryGroup: string;
  vendorId: string | null;
  vendorName: string | null;
  kind: 'EXPENSE' | 'VENDOR_CREDIT_NOTE';
  description: string;
  currency: string;
  net: MoneyAmount;
  vat: MoneyAmount;
  gross: MoneyAmount;
  wht: MoneyAmount;
  paid: MoneyAmount;
  vatClaimable: boolean;
  vatClaimedPeriod: string | null;
  whtRateBp: number;
  expenseDate: string;
  paidDate: string | null;
  paymentMethod: string | null;
  supplierDocNumber: string | null;
  note: string | null;
  recordedBy: string | null;
  recordedAt: string;
  voidedAt: string | null;
  voidedReason: string | null;
}

export interface ProfitLossReport {
  currency: string;
  revenue: {
    room: MoneyAmount;
    extras: MoneyAmount;
    other: MoneyAmount;
    serviceCharge: MoneyAmount;
    total: MoneyAmount;
  };
  expenseGroups: {
    group: string;
    total: MoneyAmount;
    categories: {
      categoryId: string;
      categoryCode: string;
      categoryNameTh: string;
      categoryNameEn: string;
      amount: MoneyAmount;
    }[];
  }[];
  totalExpenses: MoneyAmount;
  nonDeductibleExpenses: MoneyAmount;
  netProfit: MoneyAmount;
  retained: MoneyAmount;
  vat: { output: MoneyAmount; reclaimableInput: MoneyAmount; netPayable: MoneyAmount };
}

export interface AccountingSummary {
  year: number;
  month: number;
  basis: 'CASH' | 'ACCRUAL';
  currency: string;
  revenue: MoneyAmount;
  expenses: MoneyAmount;
  netProfit: MoneyAmount;
  netVatPayable: MoneyAmount;
  previous: { revenue: MoneyAmount; expenses: MoneyAmount; netProfit: MoneyAmount };
  profitLoss: ProfitLossReport;
  missingRecurring: {
    label: string;
    categoryId: string;
    categoryNameTh: string;
    categoryNameEn: string;
    expectedAmountMinor: number | null;
  }[];
}

export interface CashBookReport {
  currency: string;
  from: string;
  to: string;
  openingBalance: MoneyAmount;
  totalReceived: MoneyAmount;
  totalPaid: MoneyAmount;
  closingBalance: MoneyAmount;
  items: {
    seq: number;
    date: string;
    description: string;
    reference: string | null;
    source: string;
    received: MoneyAmount;
    paid: MoneyAmount;
    balance: MoneyAmount;
  }[];
}

export interface NewExpenseInput {
  categoryId: string;
  vendorId?: string | null;
  description: string;
  amount: number;
  amountIs?: 'GROSS' | 'NET';
  vatRateBp?: number | null;
  vatClaimable?: boolean;
  whtRateBp?: number;
  expenseDate?: string | null;
  paidDate?: string | null;
  paymentMethod?: string | null;
  supplierDocNumber?: string | null;
  supplierDocDate?: string | null;
  note?: string | null;
}

export const api = {
  accountingSettings: (propertyId: string) =>
    request<AccountingSettings>(`/properties/${propertyId}/accounting/settings`),

  saveAccountingSettings: (propertyId: string, input: Partial<AccountingSettings>) =>
    request<AccountingSettings>(`/properties/${propertyId}/accounting/settings`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  expenseCategories: (propertyId: string) =>
    request<{ items: ExpenseCategory[] }>(`/properties/${propertyId}/accounting/categories`).then(
      (r) => r.items,
    ),

  vendors: (propertyId: string) =>
    request<{ items: Vendor[] }>(`/properties/${propertyId}/accounting/vendors`).then(
      (r) => r.items,
    ),

  createVendor: (
    propertyId: string,
    input: {
      name: string;
      taxId?: string | null;
      taxpayerType?: string | null;
      isForeign?: boolean;
    },
  ) =>
    request<Vendor>(`/properties/${propertyId}/accounting/vendors`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  expenses: (
    propertyId: string,
    from: string,
    to: string,
    options: { basis?: 'CASH' | 'ACCRUAL'; categoryId?: string; includeVoided?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ from, to });
    if (options.basis) params.set('basis', options.basis);
    if (options.categoryId) params.set('categoryId', options.categoryId);
    if (options.includeVoided) params.set('includeVoided', 'true');
    return request<{ items: Expense[] }>(
      `/properties/${propertyId}/accounting/expenses?${params.toString()}`,
    ).then((r) => r.items);
  },

  createExpense: (propertyId: string, input: NewExpenseInput) =>
    request<Expense>(`/properties/${propertyId}/accounting/expenses`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  voidExpense: (propertyId: string, expenseId: string, reason: string) =>
    request<Expense>(`/properties/${propertyId}/accounting/expenses/${expenseId}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  accountingSummary: (
    propertyId: string,
    year: number,
    month: number,
    basis?: 'CASH' | 'ACCRUAL',
  ) => {
    const params = new URLSearchParams({ year: String(year), month: String(month) });
    if (basis) params.set('basis', basis);
    return request<AccountingSummary>(
      `/properties/${propertyId}/accounting/summary?${params.toString()}`,
    );
  },

  profitLoss: (propertyId: string, from: string, to: string, basis: 'CASH' | 'ACCRUAL') =>
    request<ProfitLossReport>(
      `/properties/${propertyId}/accounting/reports/profit-loss?from=${from}&to=${to}&basis=${basis}`,
    ),

  cashBook: (propertyId: string, from: string, to: string) =>
    request<CashBookReport>(
      `/properties/${propertyId}/accounting/reports/cash-book?from=${from}&to=${to}`,
    ),

  me: () =>
    request<{
      id: string;
      email: string;
      fullName: string;
      organizationId: string;
      /** 'en' | 'th', or null when this person never chose. */
      preferredLocale: string | null;
      memberships: { role: string; propertyId: string | null }[];
      capabilities: string[];
    }>('/auth/me'),

  setPreferredLocale: (preferredLocale: 'en' | 'th') =>
    request<{ preferredLocale: string }>('/auth/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ preferredLocale }),
    }),

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

  property: (propertyId: string) => request<PropertyProfile>(`/properties/${propertyId}`),

  updateProperty: (propertyId: string, input: UpdatePropertyInput) =>
    request<PropertyProfile>(`/properties/${propertyId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  media: (propertyId: string) => request<MediaListing>(`/properties/${propertyId}/media`),

  createMediaUpload: (propertyId: string, input: CreateMediaUploadInput) =>
    request<MediaUploadGrant>(`/properties/${propertyId}/media/uploads`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  attachMedia: (propertyId: string, input: AttachMediaInput) =>
    request<MediaItem>(`/properties/${propertyId}/media`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateMedia: (propertyId: string, mediaId: string, input: UpdateMediaInput) =>
    request<MediaItem>(`/properties/${propertyId}/media/${mediaId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteMedia: (propertyId: string, mediaId: string) =>
    request<void>(`/properties/${propertyId}/media/${mediaId}`, { method: 'DELETE' }),

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
    request<{ pricesUpdated: number; ratePlansTouched: number }>(
      `/properties/${propertyId}/rates`,
      { method: 'PATCH', body: JSON.stringify({ updates }) },
    ),

  deleteRates: (propertyId: string, deletions: RateDeletion[]) =>
    request<RateDeletionResult>(`/properties/${propertyId}/rates`, {
      method: 'DELETE',
      body: JSON.stringify({ deletions }),
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

  bookingSources: (propertyId: string) =>
    request<{ items: BookingSource[] }>(`/properties/${propertyId}/booking-sources`).then(
      (body) => body.items,
    ),

  createBookingSource: (
    propertyId: string,
    input: { name: string; kind: 'OTA' | 'TRAVEL_AGENT' },
  ) =>
    request<BookingSource>(`/properties/${propertyId}/booking-sources`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateBookingSource: (
    propertyId: string,
    sourceId: string,
    input: { name?: string; isActive?: boolean },
  ) =>
    request<BookingSource>(`/properties/${propertyId}/booking-sources/${sourceId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  addDefaultBookingSources: (propertyId: string) =>
    request<{ items: BookingSource[] }>(`/properties/${propertyId}/booking-sources/defaults`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((body) => body.items),

  assignableRooms: (propertyId: string, checkIn: string, checkOut: string) =>
    request<{ items: AssignableRoom[] }>(
      `/properties/${propertyId}/rooms/assignable?checkIn=${checkIn}&checkOut=${checkOut}`,
    ),

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

  checkOut: (
    propertyId: string,
    reservationId: string,
    version: number,
    releaseRemainingNights = false,
  ) =>
    request<{
      id: string;
      status: string;
      roomsToClean: string[];
      nightsReleased: string[];
    }>(`/properties/${propertyId}/reservations/${reservationId}/check-out`, {
      method: 'POST',
      body: JSON.stringify({ version, releaseRemainingNights }),
    }),

  guests: (propertyId: string, q?: string) =>
    request<{ items: Guest[] }>(
      `/properties/${propertyId}/guests${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ).then((body) => body.items),

  guestDuplicates: (propertyId: string, guestId: string) =>
    request<{ items: DuplicateGuest[] }>(
      `/properties/${propertyId}/guests/${guestId}/duplicates`,
    ).then((body) => body.items),

  /** The guest in the path survives; the one in the body is folded into it. */
  mergeGuest: (propertyId: string, survivorId: string, duplicateId: string) =>
    request<MergeGuestResult>(`/properties/${propertyId}/guests/${survivorId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ duplicateId }),
    }),

  channels: (propertyId: string) =>
    request<{ items: ChannelSummary[] }>(`/properties/${propertyId}/channels`).then(
      (body) => body.items,
    ),

  channel: (propertyId: string, channelId: string) =>
    request<ChannelDetail>(`/properties/${propertyId}/channels/${channelId}`),

  createChannel: (propertyId: string, input: CreateChannelInput) =>
    request<{ id: string }>(`/properties/${propertyId}/channels`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateChannel: (propertyId: string, channelId: string, input: UpdateChannelInput) =>
    request<ChannelDetail>(`/properties/${propertyId}/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  replaceChannelMappings: (
    propertyId: string,
    channelId: string,
    input: { roomTypes: MappingInput[]; ratePlans: RatePlanMappingInput[] },
  ) =>
    request<ChannelDetail>(`/properties/${propertyId}/channels/${channelId}/mappings`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  testChannelConnection: (propertyId: string, channelId: string) =>
    request<ConnectionTest>(`/properties/${propertyId}/channels/${channelId}/test-connection`, {
      method: 'POST',
    }),

  autoMapChannel: (propertyId: string, channelId: string) =>
    request<{ roomTypes: number; ratePlans: number }>(
      `/properties/${propertyId}/channels/${channelId}/auto-map`,
      { method: 'POST' },
    ),

  syncChannel: (propertyId: string, channelId: string) =>
    request<ForceSyncResult>(`/properties/${propertyId}/channels/${channelId}/sync`, {
      method: 'POST',
    }),

  notifications: (propertyId: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    return request<NotificationPage>(
      `/properties/${propertyId}/notifications${query ? `?${query}` : ''}`,
    );
  },

  audit: (propertyId: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    return request<AuditPage>(`/properties/${propertyId}/audit${query ? `?${query}` : ''}`);
  },

  performance: (propertyId: string, from: string, to: string) =>
    request<Performance>(`/properties/${propertyId}/reports/performance?from=${from}&to=${to}`),

  pickup: (propertyId: string, from: string, to: string, asOf: string) =>
    request<Pickup>(`/properties/${propertyId}/reports/pickup?from=${from}&to=${to}&asOf=${asOf}`),

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

  createReservation: (propertyId: string, input: CreateReservationInput) =>
    request<CreatedReservation>(`/properties/${propertyId}/reservations`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  modifyStay: (propertyId: string, reservationId: string, stayId: string, input: ModifyStayInput) =>
    request<ModifiedStay>(
      `/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),

  extendStay: (propertyId: string, reservationId: string, stayId: string, input: ExtendStayInput) =>
    request<ExtendedStay>(
      `/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/extend`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  shortenStay: (
    propertyId: string,
    reservationId: string,
    stayId: string,
    input: ShortenStayInput,
  ) =>
    request<ShortenedStay>(
      `/properties/${propertyId}/reservations/${reservationId}/stays/${stayId}/shorten`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  folio: (propertyId: string, reservationId: string) =>
    request<Folio>(`/properties/${propertyId}/reservations/${reservationId}/folio`),

  postFolioCharge: (
    propertyId: string,
    reservationId: string,
    input: { kind: FolioChargeKind; amount: number; description?: string; taxable?: boolean },
  ) =>
    request<Folio>(`/properties/${propertyId}/reservations/${reservationId}/folio/charges`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  recordFolioPayment: (
    propertyId: string,
    reservationId: string,
    input: {
      kind?: FolioPaymentKind;
      method: FolioPaymentMethod;
      amount: number;
      reference?: string;
    },
  ) =>
    request<Folio>(`/properties/${propertyId}/reservations/${reservationId}/folio/payments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  voidFolioLine: (
    propertyId: string,
    reservationId: string,
    line: { kind: 'CHARGE' | 'PAYMENT'; id: string },
    reason: string,
  ) =>
    request<Folio>(
      `/properties/${propertyId}/reservations/${reservationId}/folio/${
        line.kind === 'CHARGE' ? 'charges' : 'payments'
      }/${line.id}/void`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  cancelReservation: (propertyId: string, id: string, version: number, reason?: string) =>
    request<{ id: string; status: string; releasedNights: string[]; retainedNights: string[] }>(
      `/properties/${propertyId}/reservations/${id}/cancel`,
      { method: 'POST', body: JSON.stringify({ version, ...(reason ? { reason } : {}) }) },
    ),
};
