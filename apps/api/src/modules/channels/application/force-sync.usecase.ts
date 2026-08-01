import { Inject, Injectable, Logger } from '@nestjs/common';
import { dateRange, errors, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { CHANNEL_REPOSITORY, type ChannelRepository } from '../domain/channel.repository';
import { PushAriUseCase } from './push-ari.usecase';

export interface ForceSyncInput {
  readonly propertyId: string;
  readonly channelId: string;
}

export interface ForceSyncRoomTypeResult {
  readonly roomTypeId: string;
  readonly accepted: number;
  readonly rejected: number;
  readonly warnings: readonly string[];
  /** Set when the push threw. The other room types are still attempted. */
  readonly error: string | null;
}

export interface ForceSyncResult {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly nights: number;
  readonly roomTypes: readonly ForceSyncRoomTypeResult[];
}

/**
 * Push everything to a channel, now, because somebody asked.
 *
 * The sync engine is event-driven: a change writes an outbox event and the
 * worker pushes the affected nights. That is right for the steady state and
 * cannot help in the three cases an operator actually needs — the channel was
 * inactive while prices changed, a mapping was fixed after a failed push, or
 * nobody trusts what the OTA is currently showing.
 *
 * **It runs INLINE rather than enqueuing.** Two reasons. The operator clicked a
 * button and should see the result, not a job id. And enqueuing would need
 * Redis, which is exactly what a deployment with `enable_channel_sync` off does
 * not have — so a forced sync is also the only way such a deployment can push
 * at all. That is a real capability, not a workaround.
 *
 * **One room type failing does not stop the others.** A missing rate mapping on
 * one room type is a common, local problem; abandoning the whole sync over it
 * would leave the channel in a worse state than before the button was pressed.
 * Every outcome is reported per room type.
 */
@Injectable()
export class ForceSyncUseCase {
  private readonly logger = new Logger(ForceSyncUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepository,
    private readonly push: PushAriUseCase,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: ForceSyncInput,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<ForceSyncResult> {
    const tenant = requireTenant();

    const channel = await this.channels.findById(this.db, input.channelId);
    if (!channel || channel.propertyId !== input.propertyId) {
      throw errors.notFound('Channel', input.channelId);
    }

    /*
     * An INACTIVE channel is refused. Pushing to one would make an OTA start
     * selling rooms the hotel has deliberately taken off it — the exact
     * accident that activation's mapping check exists to prevent, arrived at
     * through a different door.
     */
    if (channel.status !== 'ACTIVE') {
      throw errors.conflict(`A ${channel.status} channel cannot be synced`, {
        channelId: channel.id,
        status: channel.status,
      });
    }

    const roomTypeIds = await this.channels.findMappedRoomTypeIds(this.db, input.channelId);
    if (roomTypeIds.length === 0) {
      throw errors.conflict('This channel has no room type mapped, so there is nothing to push', {
        channelId: channel.id,
      });
    }

    // From today in UTC rather than the property's timezone: the horizon is a
    // window of future nights, and being one day out at its far edge changes
    // nothing. Today's own night IS included — it can still be sold.
    const from = toIsoDate(now.toISOString().slice(0, 10));
    const to = addDays(from, channel.syncHorizonDays);
    const dates = dateRange(from, to);

    const roomTypes: ForceSyncRoomTypeResult[] = [];
    for (const roomTypeId of roomTypeIds) {
      try {
        const result = await this.push.execute({ channelId: channel.id, roomTypeId, dates });
        roomTypes.push({ roomTypeId, ...result, error: null });
      } catch (error) {
        this.logger.warn(
          `Forced sync of room type ${roomTypeId} on channel ${channel.id} failed: ${String(error)}`,
        );
        roomTypes.push({
          roomTypeId,
          accepted: 0,
          rejected: 0,
          warnings: [],
          error: String(error).slice(0, 500),
        });
      }
    }

    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: channel.propertyId,
        actor,
        action: 'channel.force_synced',
        entityType: 'channel',
        entityId: channel.id,
        after: {
          from,
          to,
          nights: dates.length,
          roomTypes: roomTypes.map((row) => ({
            roomTypeId: row.roomTypeId,
            accepted: row.accepted,
            rejected: row.rejected,
            error: row.error,
          })),
        },
      });
    });

    return { from, to, nights: dates.length, roomTypes };
  }
}

function addDays(date: IsoDate, days: number): IsoDate {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return toIsoDate(value.toISOString().slice(0, 10));
}
