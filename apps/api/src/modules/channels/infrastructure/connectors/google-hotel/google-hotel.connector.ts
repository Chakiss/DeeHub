import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '@deehub/shared';
import { DATABASE, type Database } from '../../../../../database/database.module';
import { ENV, type Env } from '../../../../../config/env';
import {
  RATE_PLAN_REPOSITORY,
  type RatePlanRepository,
} from '../../../../rate-plans/domain/rate-plan.repository';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRepository,
} from '../../../../room-types/domain/room-type.repository';
import type {
  AriPayload,
  ChannelConnector,
  ChannelContext,
  ChannelType,
  HealthResult,
  InboundReservation,
  PushResult,
} from '../../../domain/channel-connector';
import { CHANNEL_REPOSITORY, type ChannelRepository } from '../../../domain/channel.repository';
import { buildAriDocuments, parseUploadResponse } from './ari-xml';
import { buildPropertyData } from './property-data-xml';

/** Google's upload paths, relative to GOOGLE_HOTEL_UPLOAD_URL. */
const PATHS = {
  propertyData: '/property_data',
  rates: '/ota/hotel_rate_amount_notif',
  availability: '/ota/hotel_avail_notif',
  inventory: '/ota/hotel_inv_count_notif',
} as const;

const TIMEOUT_MS = 30_000;

/**
 * Google Hotels — free booking links and Hotel Ads — as a channel.
 *
 * Outbound only. Google is a metasearch: it shows the hotel's own price and
 * sends the traveller to our booking page to buy it, so nothing ever comes
 * back through this connector and `fetchReservations`/`parseWebhook` are
 * honest no-ops. The booking arrives as DIRECT through the booking engine.
 *
 * What is Google-specific stays here: the three OTA-flavoured XML documents
 * an ARI push becomes, the Transaction message that describes rooms and
 * packages before Google will price them, the `HotelCode` = property id
 * convention shared with the Hotel List Feed, and the fact that Google
 * authenticates by the sender's IP rather than a credential — which is why
 * a channel of this type has no credentials at all.
 *
 * Every ARI push also carries the all-in price (`grossMinor`) that the
 * booking page will charge, so the figure on Google is the figure at the
 * checkout — Google audits exactly that.
 */
@Injectable()
export class GoogleHotelConnector implements ChannelConnector {
  readonly type: ChannelType = 'GOOGLE_HOTEL';
  private readonly logger = new Logger(GoogleHotelConnector.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepository,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly roomTypes: RoomTypeRepository,
    @Inject(RATE_PLAN_REPOSITORY) private readonly ratePlans: RatePlanRepository,
  ) {}

  async pushAri(ctx: ChannelContext, payload: AriPayload): Promise<PushResult> {
    const hotelCode = this.hotelCode(ctx);
    const documents = buildAriDocuments(hotelCode, payload);

    const warnings: string[] = [];
    let accepted = 0;
    let rejected = 0;
    for (const [name, path, body] of [
      ['rates', PATHS.rates, documents.rates],
      ['availability', PATHS.availability, documents.availability],
      ['inventory', PATHS.inventory, documents.inventory],
    ] as const) {
      const result = await this.upload(path, body);
      warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`));
      if (result.success) accepted += 1;
      else {
        rejected += 1;
        warnings.push(...result.errors.map((error) => `${name}: ${error}`));
      }
    }

    if (rejected > 0) {
      // Throwing lets the caller retry with backoff; Google's errors are
      // usually a message we built wrong, and silence would leave stale
      // prices on Google — the failure mode price accuracy punishes.
      throw new DomainError(
        'INTERNAL_ERROR',
        `Google rejected ${String(rejected)} of 3 ARI document(s): ${warnings.join('; ')}`,
      );
    }
    // Counted in nights, like every other connector, so the sync log reads the same.
    return { accepted: payload.nights.length, rejected: 0, warnings };
  }

  async pushCatalog(ctx: ChannelContext): Promise<PushResult> {
    const partner = this.partner();
    const hotelCode = this.hotelCode(ctx);

    const [rooms, plans] = await Promise.all([
      this.roomTypes.list(this.db, ctx.propertyId),
      this.ratePlans.list(this.db, ctx.propertyId),
    ]);
    const roomMappings = new Map<string, string>();
    for (const room of rooms) {
      const external = await this.channels.findRoomTypeMapping(this.db, ctx.channelId, room.id);
      if (external) roomMappings.set(room.id, external);
    }
    const planMappings = new Map<string, string>();
    for (const room of rooms) {
      for (const mapping of await this.channels.findRatePlanMappings(
        this.db,
        ctx.channelId,
        room.id,
      )) {
        planMappings.set(mapping.ratePlanId, mapping.externalRateId);
      }
    }

    const body = buildPropertyData(
      partner,
      hotelCode,
      rooms
        .filter((room) => room.isActive && roomMappings.has(room.id))
        .map((room) => ({
          externalRoomId: roomMappings.get(room.id) as string,
          name: room.name,
          description: room.description,
          maxOccupancy: room.maxOccupancy,
        })),
      plans
        .filter((plan) => plan.isActive && plan.sellOnline && planMappings.has(plan.id))
        .map((plan) => ({
          externalRateId: planMappings.get(plan.id) as string,
          name: plan.name,
          description: null,
          refundable: plan.isRefundable,
          breakfastIncluded: plan.mealPlan !== 'ROOM_ONLY',
        })),
      'en',
    );

    const result = await this.upload(PATHS.propertyData, body);
    if (!result.success) {
      throw new DomainError(
        'INTERNAL_ERROR',
        `Google rejected the property data: ${result.errors.join('; ') || 'no detail'}`,
      );
    }
    return { accepted: rooms.length, rejected: 0, warnings: result.warnings };
  }

  async fetchReservations(): Promise<readonly InboundReservation[]> {
    return [];
  }

  parseWebhook(): readonly InboundReservation[] {
    // Google never sends bookings; a stranger POSTing here gets nothing.
    return [];
  }

  /**
   * The only round trip that proves anything is a real upload: Google
   * answers 403 when this deployment's IP is not on the Hotel Center
   * allow-list, which is the mistake this button exists to catch. The
   * property data message is the cheapest one with no side effect on prices.
   */
  async testConnection(ctx: ChannelContext): Promise<HealthResult> {
    const startedAt = Date.now();
    try {
      const result = await this.pushCatalog(ctx);
      return {
        ok: true,
        detail:
          `Google accepted the property data for ${this.hotelCode(ctx)}` +
          (result.warnings.length > 0 ? ` (warnings: ${result.warnings.join('; ')})` : ''),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private hotelCode(ctx: ChannelContext): string {
    // The property id, never a code the hotel could rename: it is what the
    // Hotel List Feed carried and what Google matched the listing on.
    const configured = ctx.settings['hotelId'];
    return typeof configured === 'string' && configured.length > 0 ? configured : ctx.propertyId;
  }

  private partner(): string {
    const partner = this.env.GOOGLE_HOTEL_PARTNER_KEY;
    if (!partner) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'GOOGLE_HOTEL_PARTNER_KEY is not set: this deployment is not registered with Hotel Center',
      );
    }
    return partner;
  }

  private async upload(
    path: string,
    body: string,
  ): Promise<{ success: boolean; warnings: string[]; errors: string[] }> {
    this.partner();
    const url = `${this.env.GOOGLE_HOTEL_UPLOAD_URL.replace(/\/+$/, '')}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status === 403) {
      // Said in the words the operator needs: it is the allow-list, not us.
      throw new DomainError(
        'INTERNAL_ERROR',
        "Google answered 403: this server's IP address is not on the Hotel Center allow-list",
      );
    }
    if (!response.ok) {
      throw new DomainError(
        'INTERNAL_ERROR',
        `Google answered ${String(response.status)} for ${path}: ${text.slice(0, 300)}`,
      );
    }
    const parsed = parseUploadResponse(text);
    if (parsed.warnings.length > 0) {
      this.logger.warn(`Google warned on ${path}: ${parsed.warnings.join('; ')}`);
    }
    return parsed;
  }
}
