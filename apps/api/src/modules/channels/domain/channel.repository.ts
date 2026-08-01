import type { Executor } from '../../../database/executor';
import type { ChannelContext, ChannelType } from './channel-connector';

export interface ChannelRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly type: ChannelType;
  readonly name: string;
  readonly status: string;
  readonly syncHorizonDays: number;
}

export interface RatePlanMapping {
  readonly ratePlanId: string;
  readonly externalRateId: string;
}

export interface SyncJobRecord {
  readonly channelId: string;
  readonly organizationId: string;
  readonly kind: 'ARI_PUSH' | 'RESERVATION_PULL' | 'FULL_SYNC';
  readonly roomTypeId: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export interface ChannelRepository {
  findById(tx: Executor, channelId: string): Promise<ChannelRecord | null>;

  /** Channel plus DECRYPTED credentials. Never log the result. */
  loadContext(tx: Executor, channelId: string): Promise<ChannelContext | null>;

  findRoomTypeMapping(tx: Executor, channelId: string, roomTypeId: string): Promise<string | null>;

  /**
   * Every room type this channel is mapped to sell.
   *
   * The forced sync needs the whole set; the ARI push needs one at a time. An
   * unmapped room type is deliberately absent rather than returned with a null
   * external id — the push already skips those, and a forced sync that reported
   * "pushed 3 of 5" without saying which is not worth the row.
   */
  findMappedRoomTypeIds(tx: Executor, channelId: string): Promise<readonly string[]>;

  /** Rate-plan mappings for one room type on one channel. */
  findRatePlanMappings(
    tx: Executor,
    channelId: string,
    roomTypeId: string,
  ): Promise<readonly RatePlanMapping[]>;

  recordSyncJob(tx: Executor, job: SyncJobRecord): Promise<void>;

  /** Updates the channel health strip the dashboard shows. */
  markSynced(tx: Executor, channelId: string, at: Date, error: string | null): Promise<void>;

  /**
   * Record the outcome of a connection test WITHOUT touching status.
   *
   * Separate from `markSynced`, which is the sync engine's and does move status
   * — a failing push means an active channel is erroring. A test is diagnostic:
   * an INACTIVE channel that fails one is still switched off, not broken, and
   * flipping it to ERROR would also collide with
   * `channels_property_type_active_uq`, the partial unique index that allows
   * only one non-inactive channel per type per property.
   */
  recordConnectionTest(
    tx: Executor,
    channelId: string,
    at: Date,
    error: string | null,
  ): Promise<void>;
}

export const CHANNEL_REPOSITORY = Symbol('CHANNEL_REPOSITORY');
