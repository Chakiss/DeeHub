import type { IsoDate } from '@deehub/shared';

/**
 * The OTA connector port (architecture.md §6).
 *
 * The master prompt's rule — never hardcode OTA-specific logic into business
 * modules — is realized here. Inventory and Reservations know only this
 * interface; Agoda, Booking.com and the Mock OTA are interchangeable
 * infrastructure adapters. Every OTA's auth scheme, payload shape, quirks and
 * rate limits stay behind it.
 *
 * Every future connector must pass the same contract test suite the Mock OTA
 * passes.
 */

export const CHANNEL_TYPES = [
  'MOCK_OTA',
  'AGODA',
  'BOOKING_COM',
  'EXPEDIA',
  'TRIP_COM',
  'AIRBNB',
  'DIRECT',
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Everything a connector needs to talk to one channel for one property. */
export interface ChannelContext {
  readonly channelId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly type: ChannelType;
  /** Decrypted at the edge of the application layer; never logged. */
  readonly credentials: Readonly<Record<string, string>>;
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface AriRate {
  /** The channel's own identifier for this rate plan. */
  readonly externalRateId: string;
  readonly occupancy: number;
  readonly amountMinor: number;
  readonly currency: string;
}

/** One night of state for one room type, as the channel should see it. */
export interface AriNight {
  readonly date: IsoDate;
  /** Sellable units remaining: allotment − booked. Absolute, not a delta. */
  readonly available: number;
  readonly stopSell: boolean;
  readonly minStay: number;
  readonly maxStay: number | null;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
  readonly rates: readonly AriRate[];
}

export interface AriPayload {
  readonly externalRoomId: string;
  readonly nights: readonly AriNight[];
}

export interface PushResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly warnings: readonly string[];
}

export interface HealthResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly latencyMs: number;
}

/** A booking as the channel described it, before mapping to our domain. */
export interface InboundReservation {
  readonly externalReservationId: string;
  readonly externalStatus: string;
  readonly externalRoomId: string;
  readonly externalRateId: string | null;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly children: number;
  readonly guestName: string;
  readonly guestEmail: string | null;
  readonly guestPhone: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly raw: unknown;
}

export interface ChannelConnector {
  readonly type: ChannelType;

  /**
   * Send absolute availability, rates and restrictions.
   *
   * Absolute rather than incremental on purpose: it makes the operation
   * idempotent, so the at-least-once delivery of the outbox relay is safe, and
   * a retry after a timeout cannot double-apply anything.
   */
  pushAri(ctx: ChannelContext, payload: AriPayload): Promise<PushResult>;

  /** Pull bookings for channels without webhooks. */
  fetchReservations(ctx: ChannelContext, since: Date): Promise<readonly InboundReservation[]>;

  /**
   * Verify and parse an inbound webhook body.
   *
   * Takes the RAW body: signature verification must happen before parsing, and
   * over the exact bytes received.
   */
  parseWebhook(
    ctx: ChannelContext,
    rawBody: string,
    signature: string | undefined,
  ): readonly InboundReservation[];

  testConnection(ctx: ChannelContext): Promise<HealthResult>;
}

export const CONNECTOR_REGISTRY = Symbol('CONNECTOR_REGISTRY');
