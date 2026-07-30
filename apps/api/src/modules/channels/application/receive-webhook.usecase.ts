import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EVENT_TYPES, errors, isDomainError } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { channelReservations } from '../../../database/schema';
import { newId } from '../../../common/ids';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { ConnectorRegistry } from '../domain/connector.registry';
import { CHANNEL_REPOSITORY, type ChannelRepository } from '../domain/channel.repository';

export interface ReceiveWebhookInput {
  readonly channelId: string;
  /** The exact bytes received. Signature verification depends on it. */
  readonly rawBody: string;
  readonly signature: string | undefined;
}

export interface ReceiveWebhookResult {
  readonly received: number;
  readonly duplicates: number;
  /** Stored but not understood; parked for staff rather than discarded. */
  readonly quarantined: number;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Postgres error code for the given error, unwrapping Drizzle's query wrapper.
 *
 * Drizzle re-throws driver errors wrapped in its own Error with the pg error on
 * `cause`. Checking only the top level silently never matches, which turns a
 * handled duplicate into an unhandled 500.
 */
function pgError(error: unknown): { code?: unknown; constraint?: unknown } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * Accept an inbound channel webhook (api-spec.md §6.9).
 *
 * STORE, then process. The handler verifies the signature, writes the raw
 * payload, and returns — mapping happens in the worker. OTAs retry aggressively
 * on slow responses, so doing the work inline would turn one booking into
 * several. Deduplication is the unique index on
 * (channel, externalReservationId), which makes redelivery a no-op rather than
 * a double booking.
 */
@Injectable()
export class ReceiveWebhookUseCase {
  private readonly logger = new Logger(ReceiveWebhookUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepository,
    private readonly registry: ConnectorRegistry,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ReceiveWebhookInput): Promise<ReceiveWebhookResult> {
    const channel = await this.channels.findById(this.db, input.channelId);
    // Unauthenticated endpoint: an unknown channel id must not reveal whether
    // it exists, so this is the same 404 as any other miss.
    if (!channel) throw errors.notFound('Channel', input.channelId);

    const context = await this.channels.loadContext(this.db, input.channelId);
    if (!context) throw errors.notFound('Channel', input.channelId);

    const connector = this.registry.get(context.type);

    let bookings;
    try {
      // Throws on a bad signature BEFORE the body is parsed.
      bookings = connector.parseWebhook(context, input.rawBody, input.signature);
    } catch (error) {
      // A bad signature means it is not from the OTA — refuse it.
      if (isDomainError(error) && error.code === 'UNAUTHENTICATED') throw error;

      // The signature was valid, so this genuinely came from the channel; we
      // simply cannot understand it. Discarding it would strand a real guest
      // (domain-model.md §3.8), so park the raw body for staff instead.
      const quarantined = await runWithTenant(
        {
          organizationId: channel.organizationId,
          userId: null,
          propertyId: channel.propertyId,
          requestId: `webhook-${channel.id}`,
        },
        () =>
          this.quarantine(
            channel,
            input.rawBody,
            error instanceof Error ? error.message : String(error),
          ),
      );
      this.logger.error(
        `Unparseable webhook from channel ${channel.id} stored for review: ${String(error)}`,
      );
      return { received: 0, duplicates: quarantined ? 0 : 1, quarantined: quarantined ? 1 : 0 };
    }

    let received = 0;
    let duplicates = 0;

    for (const booking of bookings) {
      const inserted = await runWithTenant(
        {
          organizationId: channel.organizationId,
          userId: null,
          propertyId: channel.propertyId,
          requestId: `webhook-${channel.id}`,
        },
        () => this.store(channel, booking),
      );
      if (inserted) received += 1;
      else duplicates += 1;
    }

    if (duplicates > 0) {
      this.logger.debug(
        `Ignored ${String(duplicates)} redelivered booking(s) from channel ${channel.id}`,
      );
    }
    return { received, duplicates, quarantined: 0 };
  }

  /**
   * Store a payload we could not parse, keyed by a hash of its bytes so a
   * redelivery of the same broken message still deduplicates.
   */
  private async quarantine(
    channel: { id: string; organizationId: string; propertyId: string },
    rawBody: string,
    reason: string,
  ): Promise<boolean> {
    const digest = createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
    try {
      await this.db.insert(channelReservations).values({
        id: newId(),
        organizationId: channel.organizationId,
        channelId: channel.id,
        externalReservationId: `UNPARSEABLE-${digest}`,
        externalStatus: 'UNPARSEABLE',
        rawPayload: { rawBody },
        status: 'FAILED',
        error: reason.slice(0, 1_000),
      });
      return true;
    } catch (error) {
      if (this.isDuplicate(error)) return false;
      throw error;
    }
  }

  private async store(
    channel: { id: string; organizationId: string; propertyId: string },
    booking: { externalReservationId: string; externalStatus: string; raw: unknown },
  ): Promise<boolean> {
    const id = newId();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(channelReservations).values({
          id,
          organizationId: channel.organizationId,
          channelId: channel.id,
          externalReservationId: booking.externalReservationId,
          externalStatus: booking.externalStatus,
          rawPayload: booking as unknown as Record<string, unknown>,
          status: 'RECEIVED',
        });

        // The relay turns this into a delivery job after commit, so a booking
        // is queued only once it is durably stored.
        await this.outbox.record(tx, {
          type: EVENT_TYPES.CHANNEL_RESERVATION_RECEIVED,
          organizationId: channel.organizationId,
          propertyId: channel.propertyId,
          aggregateType: 'channelReservation',
          aggregateId: id,
          payload: {
            channelReservationId: id,
            channelId: channel.id,
            externalReservationId: booking.externalReservationId,
          },
        });
      });
      return true;
    } catch (error) {
      // The dedupe index did its job: the OTA sent this booking again.
      if (this.isDuplicate(error)) return false;
      throw error;
    }
  }

  private isDuplicate(error: unknown): boolean {
    const pg = pgError(error);
    return (
      pg?.code === UNIQUE_VIOLATION &&
      typeof pg.constraint === 'string' &&
      pg.constraint.includes('channel_reservations_dedupe_uq')
    );
  }
}
