import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { errors, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import {
  channelRatePlanMappings,
  channelRoomTypeMappings,
  channelReservations,
  ratePlans,
} from '../../../database/schema';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { AuditService } from '../../../common/audit/audit.service';
import { CreateReservationUseCase } from '../../reservations/application/create-reservation.usecase';
import { CHANNEL_REPOSITORY, type ChannelRepository } from '../domain/channel.repository';
import type { InboundReservation } from '../domain/channel-connector';

export interface DeliverReservationInput {
  readonly channelReservationId: string;
}

export type DeliveryOutcome =
  | { readonly status: 'PROCESSED'; readonly reservationId: string; readonly overbooked: boolean }
  | { readonly status: 'ALREADY_PROCESSED'; readonly reservationId: string }
  | { readonly status: 'FAILED'; readonly error: string };

const SYSTEM_ACTOR = { type: 'CHANNEL' as const, id: null, label: 'channel-delivery' };

/**
 * Turn a stored inbound OTA booking into a reservation (domain-model.md §3.8).
 *
 * Three rules shape this:
 *
 * 1. **Never drop a booking.** Anything unmappable is left as FAILED with its
 *    raw payload intact and surfaced for staff, never discarded.
 * 2. **Never refuse one either.** The guest already holds a confirmation, so
 *    insufficient availability is absorbed and alerted rather than rejected.
 * 3. **Never create it twice.** OTAs redeliver; the unique dedupe key plus the
 *    already-processed check make redelivery a no-op.
 */
@Injectable()
export class DeliverReservationUseCase {
  private readonly logger = new Logger(DeliverReservationUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepository,
    private readonly createReservation: CreateReservationUseCase,
    private readonly audit: AuditService,
  ) {}

  async execute(input: DeliverReservationInput): Promise<DeliveryOutcome> {
    const rows = await this.db
      .select({
        id: channelReservations.id,
        organizationId: channelReservations.organizationId,
        channelId: channelReservations.channelId,
        externalReservationId: channelReservations.externalReservationId,
        status: channelReservations.status,
        reservationId: channelReservations.reservationId,
        rawPayload: channelReservations.rawPayload,
      })
      .from(channelReservations)
      .where(eq(channelReservations.id, input.channelReservationId))
      .limit(1);

    const inbound = rows[0];
    if (!inbound) throw errors.notFound('Channel reservation', input.channelReservationId);

    // Redelivery, or a retried job after a successful run.
    if (inbound.status === 'PROCESSED' && inbound.reservationId) {
      return { status: 'ALREADY_PROCESSED', reservationId: inbound.reservationId };
    }

    const channel = await this.channels.findById(this.db, inbound.channelId);
    if (!channel) throw errors.notFound('Channel', inbound.channelId);

    return runWithTenant(
      {
        organizationId: channel.organizationId,
        userId: null,
        propertyId: channel.propertyId,
        requestId: `delivery-${inbound.id}`,
      },
      async () => {
        try {
          const booking = inbound.rawPayload as unknown as InboundReservation;
          const result = await this.map(channel, booking);

          await this.db.transaction(async (tx) => {
            await tx
              .update(channelReservations)
              .set({
                status: 'PROCESSED',
                reservationId: result.reservationId,
                processedAt: new Date(),
                error: null,
              })
              .where(eq(channelReservations.id, inbound.id));

            await this.audit.record(tx, {
              organizationId: channel.organizationId,
              propertyId: channel.propertyId,
              actor: SYSTEM_ACTOR,
              action: 'channel.reservation_delivered',
              entityType: 'reservation',
              entityId: result.reservationId,
              after: {
                channelId: channel.id,
                externalReservationId: inbound.externalReservationId,
                overbooked: result.overbooked,
              },
            });
          });

          this.logger.log(
            `Delivered ${inbound.externalReservationId} from ${channel.name} as reservation ` +
              `${result.reservationId}${result.overbooked ? ' (OVERBOOKED — staff alerted)' : ''}`,
          );
          return { status: 'PROCESSED' as const, ...result };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          // FAILED, not deleted: the raw payload stays queryable so staff can
          // fix a missing mapping and reprocess. A dropped booking becomes a
          // guest arriving at a hotel with no record of them.
          await this.db
            .update(channelReservations)
            .set({ status: 'FAILED', error: message.slice(0, 1_000) })
            .where(eq(channelReservations.id, inbound.id));

          this.logger.error(
            `Failed to deliver ${inbound.externalReservationId} from ${channel.name}: ${message}`,
          );
          return { status: 'FAILED' as const, error: message };
        }
      },
    );
  }

  private async map(
    channel: { id: string; organizationId: string; propertyId: string },
    booking: InboundReservation,
  ): Promise<{ reservationId: string; overbooked: boolean }> {
    const roomTypeRows = await this.db
      .select({ roomTypeId: channelRoomTypeMappings.roomTypeId })
      .from(channelRoomTypeMappings)
      .where(
        and(
          eq(channelRoomTypeMappings.channelId, channel.id),
          eq(channelRoomTypeMappings.externalRoomId, booking.externalRoomId),
        ),
      )
      .limit(1);

    const roomTypeId = roomTypeRows[0]?.roomTypeId;
    if (!roomTypeId) {
      throw errors.mappingMissing(channel.id, 'externalRoomId', booking.externalRoomId);
    }

    const ratePlanId = await this.resolveRatePlan(channel.id, roomTypeId, booking.externalRateId);

    const result = await this.createReservation.execute(
      {
        propertyId: channel.propertyId,
        source: 'OTA',
        status: 'CONFIRMED',
        channelId: channel.id,
        booker: {
          name: booking.guestName,
          ...(booking.guestEmail ? { email: booking.guestEmail } : {}),
          ...(booking.guestPhone ? { phone: booking.guestPhone } : {}),
        },
        stays: [
          {
            roomTypeId,
            ratePlanId,
            checkIn: this.parseDate(booking.checkIn, 'check-in'),
            checkOut: this.parseDate(booking.checkOut, 'check-out'),
            adults: Math.max(1, booking.adults),
            children: Math.max(0, booking.children),
            guestName: booking.guestName,
          },
        ],
        // The channel already sold it (domain-model.md §3.8).
        onInsufficientInventory: 'ACCEPT_AND_ALERT',
      },
      { ...SYSTEM_ACTOR, label: `channel:${channel.id}` },
    );

    return { reservationId: result.id, overbooked: result.overbookings.length > 0 };
  }

  /**
   * Resolve the rate plan, falling back to any active plan for the room type.
   *
   * OTAs sometimes omit the rate identifier on a delivery even though they sent
   * it at sale time. Failing the whole booking for a missing rate reference
   * would strand a real guest, so a mapped plan for the room type is a better
   * answer than none.
   */
  private async resolveRatePlan(
    channelId: string,
    roomTypeId: string,
    externalRateId: string | null,
  ): Promise<string> {
    if (externalRateId) {
      const rows = await this.db
        .select({ ratePlanId: channelRatePlanMappings.ratePlanId })
        .from(channelRatePlanMappings)
        .where(
          and(
            eq(channelRatePlanMappings.channelId, channelId),
            eq(channelRatePlanMappings.externalRateId, externalRateId),
          ),
        )
        .limit(1);
      if (rows[0]) return rows[0].ratePlanId;
    }

    const fallback = await this.db
      .select({ ratePlanId: channelRatePlanMappings.ratePlanId })
      .from(channelRatePlanMappings)
      .innerJoin(ratePlans, eq(ratePlans.id, channelRatePlanMappings.ratePlanId))
      .where(
        and(
          eq(channelRatePlanMappings.channelId, channelId),
          eq(ratePlans.roomTypeId, roomTypeId),
          eq(ratePlans.isActive, true),
        ),
      )
      .limit(1);

    const ratePlanId = fallback[0]?.ratePlanId;
    if (!ratePlanId) {
      throw errors.mappingMissing(channelId, 'externalRateId', externalRateId ?? '(none)');
    }
    return ratePlanId;
  }

  private parseDate(value: string, label: string): IsoDate {
    try {
      return toIsoDate(value);
    } catch {
      throw errors.validation(`Channel sent an invalid ${label} date: ${value}`);
    }
  }
}
