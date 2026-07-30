import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import type {
  AriPayload,
  ChannelConnector,
  ChannelContext,
  ChannelType,
  HealthResult,
  InboundReservation,
  PushResult,
} from '../../domain/channel-connector';

/**
 * Adapter for the Mock OTA (architecture.md §6).
 *
 * Everything OTA-specific lives here: the API-key header, the `YYYYMMDD` date
 * format, prices in major units, the `hotel_code`/`room_id`/`avail` vocabulary,
 * and HMAC webhook verification. None of it crosses into Inventory or
 * Reservations.
 *
 * Prices are the subtle one. The domain holds integer minor units precisely so
 * money is exact; this OTA wants a decimal string. Converting HERE keeps the
 * lossy representation at the boundary where it belongs.
 */
@Injectable()
export class MockOtaConnector implements ChannelConnector {
  readonly type: ChannelType = 'MOCK_OTA';
  private readonly logger = new Logger(MockOtaConnector.name);

  async pushAri(ctx: ChannelContext, payload: AriPayload): Promise<PushResult> {
    const { baseUrl, apiKey, hotelCode } = this.credentials(ctx);

    const body = {
      hotel_code: hotelCode,
      room_id: payload.externalRoomId,
      nights: payload.nights.map((night) => ({
        date: toCompactDate(night.date),
        avail: night.available,
        closed: night.stopSell,
        min_los: night.minStay,
        max_los: night.maxStay,
        cta: night.closedToArrival,
        ctd: night.closedToDeparture,
        rates: night.rates.map((rate) => ({
          rate_id: rate.externalRateId,
          occupancy: rate.occupancy,
          price: toMajorUnitString(rate.amountMinor),
          currency: rate.currency,
        })),
      })),
    };

    const response = await this.request(`${baseUrl}/api/ari`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Throwing lets BullMQ retry with backoff. A 503 from a rate-limited OTA
      // is normal and must not be mistaken for a permanent failure.
      throw new DomainError(
        'INTERNAL_ERROR',
        `Mock OTA rejected the ARI push: ${String(response.status)} ${await response.text()}`,
      );
    }

    const result = (await response.json()) as {
      accepted?: number;
      rejected?: number;
      warnings?: string[];
    };

    if ((result.rejected ?? 0) > 0) {
      this.logger.warn(
        `Mock OTA rejected ${String(result.rejected)} night(s) for room ${payload.externalRoomId}: ` +
          (result.warnings ?? []).join('; '),
      );
    }

    return {
      accepted: result.accepted ?? 0,
      rejected: result.rejected ?? 0,
      warnings: result.warnings ?? [],
    };
  }

  async fetchReservations(
    ctx: ChannelContext,
    since: Date,
  ): Promise<readonly InboundReservation[]> {
    const { baseUrl, apiKey } = this.credentials(ctx);

    const response = await this.request(
      `${baseUrl}/api/bookings?since=${encodeURIComponent(since.toISOString())}`,
      { method: 'GET', headers: { 'x-api-key': apiKey } },
    );

    if (!response.ok) {
      throw new DomainError(
        'INTERNAL_ERROR',
        `Mock OTA booking pull failed: ${String(response.status)}`,
      );
    }

    const body = (await response.json()) as { bookings?: unknown[] };
    return (body.bookings ?? []).map((booking) => this.toInbound(booking));
  }

  parseWebhook(
    ctx: ChannelContext,
    rawBody: string,
    signature: string | undefined,
  ): readonly InboundReservation[] {
    const secret = ctx.credentials['webhookSecret'];
    if (!secret) {
      throw new DomainError('INTERNAL_ERROR', 'Channel is missing its webhook secret');
    }
    // Verify over the RAW bytes, before parsing. Parsing first would mean
    // trusting attacker-controlled JSON to decide whether to trust it.
    if (!this.verifySignature(rawBody, signature, secret)) {
      throw new DomainError('UNAUTHENTICATED', 'Invalid webhook signature');
    }

    const parsed = JSON.parse(rawBody) as { event?: string; booking?: unknown };
    if (parsed.event !== 'booking.created' || !parsed.booking) return [];
    return [this.toInbound(parsed.booking)];
  }

  async testConnection(ctx: ChannelContext): Promise<HealthResult> {
    const { baseUrl } = this.credentials(ctx);
    const startedAt = Date.now();
    try {
      const response = await this.request(`${baseUrl}/health`, { method: 'GET' });
      return {
        ok: response.ok,
        detail: response.ok ? 'Mock OTA reachable' : `HTTP ${String(response.status)}`,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `Unreachable: ${String(error)}`,
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private verifySignature(body: string, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
    const actual = Buffer.from(signature);
    // Length check first: timingSafeEqual throws on a mismatch.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private credentials(ctx: ChannelContext): {
    baseUrl: string;
    apiKey: string;
    hotelCode: string;
  } {
    const baseUrl = ctx.credentials['baseUrl'];
    const apiKey = ctx.credentials['apiKey'];
    const hotelCode = ctx.credentials['hotelCode'];
    if (!baseUrl || !apiKey || !hotelCode) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'Mock OTA channel requires baseUrl, apiKey and hotelCode credentials',
      );
    }
    return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, hotelCode };
  }

  /** Bounded so a hung OTA cannot pin a worker slot indefinitely. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  }

  private toInbound(raw: unknown): InboundReservation {
    const booking = raw as Record<string, unknown>;
    const arrival = fromCompactDate(String(booking['arrival'] ?? ''));
    const departure = fromCompactDate(String(booking['departure'] ?? ''));

    return {
      externalReservationId: String(booking['bookingRef'] ?? ''),
      externalStatus: String(booking['status'] ?? 'UNKNOWN'),
      externalRoomId: String(booking['roomId'] ?? ''),
      externalRateId: booking['rateId'] === null ? null : String(booking['rateId'] ?? ''),
      checkIn: arrival,
      checkOut: departure,
      adults: Number(booking['adults'] ?? 2),
      children: Number(booking['children'] ?? 0),
      guestName: String(booking['guestName'] ?? 'Guest'),
      guestEmail: booking['guestEmail'] ? String(booking['guestEmail']) : null,
      guestPhone: booking['guestPhone'] ? String(booking['guestPhone']) : null,
      totalMinor: fromMajorUnitString(String(booking['totalPrice'] ?? '0')),
      currency: String(booking['currency'] ?? 'THB'),
      raw,
    };
  }
}

/** `2026-08-12` → `20260812`, the format this OTA insists on. */
export function toCompactDate(date: IsoDate): string {
  return date.replace(/-/g, '');
}

export function fromCompactDate(compact: string): IsoDate {
  const candidate = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (!isIsoDate(candidate)) {
    throw new DomainError('VALIDATION_ERROR', `Mock OTA sent an invalid date: ${compact}`);
  }
  return toIsoDate(candidate);
}

/**
 * 250000 minor units → "2500.00".
 *
 * Built by integer division and padding rather than dividing by 100, because
 * float division is exactly the class of bug the Money type exists to prevent.
 */
export function toMajorUnitString(amountMinor: number): string {
  const negative = amountMinor < 0;
  const absolute = Math.abs(amountMinor);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? '-' : ''}${String(whole)}.${String(fraction).padStart(2, '0')}`;
}

/** "2500.00" → 250000. Rounds, so a stray third decimal cannot silently truncate. */
export function fromMajorUnitString(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new DomainError('VALIDATION_ERROR', `Mock OTA sent an invalid price: ${value}`);
  }
  return Math.round(parsed * 100);
}
