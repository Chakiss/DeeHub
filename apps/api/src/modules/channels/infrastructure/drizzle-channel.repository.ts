import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  channelRatePlanMappings,
  channelRoomTypeMappings,
  channels,
  ratePlans,
  syncJobs,
} from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import { newId } from '../../../common/ids';
import { CREDENTIAL_CIPHER, type CredentialCipher } from '../../../common/crypto/credential-cipher';
import type { ChannelContext, ChannelType } from '../domain/channel-connector';
import type {
  ChannelRecord,
  ChannelRepository,
  RatePlanMapping,
  SyncJobRecord,
} from '../domain/channel.repository';

@Injectable()
export class DrizzleChannelRepository implements ChannelRepository {
  constructor(@Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher) {}

  async findById(tx: Executor, channelId: string): Promise<ChannelRecord | null> {
    const rows = await tx
      .select({
        id: channels.id,
        organizationId: channels.organizationId,
        propertyId: channels.propertyId,
        type: channels.type,
        name: channels.name,
        status: channels.status,
        syncHorizonDays: channels.syncHorizonDays,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    const row = rows[0];
    return row ? { ...row, type: row.type as ChannelType } : null;
  }

  async loadContext(tx: Executor, channelId: string): Promise<ChannelContext | null> {
    const rows = await tx
      .select({
        id: channels.id,
        organizationId: channels.organizationId,
        propertyId: channels.propertyId,
        type: channels.type,
        credentials: channels.credentialsEncrypted,
        settings: channels.settings,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      channelId: row.id,
      organizationId: row.organizationId,
      propertyId: row.propertyId,
      type: row.type as ChannelType,
      // Decryption happens only here, at the edge of the application layer.
      credentials: row.credentials ? this.cipher.decrypt(row.credentials) : {},
      settings: (row.settings ?? {}) as Record<string, unknown>,
    };
  }

  async findMappedRoomTypeIds(tx: Executor, channelId: string): Promise<readonly string[]> {
    const rows = await tx
      .select({ roomTypeId: channelRoomTypeMappings.roomTypeId })
      .from(channelRoomTypeMappings)
      // Keyed on the channel id, like every other read here: this repository
      // is used by the worker outside any request scope, and the channel id is
      // the value a caller cannot forge into another tenant.
      .where(eq(channelRoomTypeMappings.channelId, channelId));
    return rows.map((row) => row.roomTypeId);
  }

  async findRoomTypeMapping(
    tx: Executor,
    channelId: string,
    roomTypeId: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ externalRoomId: channelRoomTypeMappings.externalRoomId })
      .from(channelRoomTypeMappings)
      .where(
        and(
          eq(channelRoomTypeMappings.channelId, channelId),
          eq(channelRoomTypeMappings.roomTypeId, roomTypeId),
        ),
      )
      .limit(1);

    return rows[0]?.externalRoomId ?? null;
  }

  async findRatePlanMappings(
    tx: Executor,
    channelId: string,
    roomTypeId: string,
  ): Promise<readonly RatePlanMapping[]> {
    // Joined through rate_plans so only this room type's plans come back: a
    // channel maps plans across the whole property.
    return tx
      .select({
        ratePlanId: channelRatePlanMappings.ratePlanId,
        externalRateId: channelRatePlanMappings.externalRateId,
        rateMultiplierBp: channelRatePlanMappings.rateMultiplierBp,
      })
      .from(channelRatePlanMappings)
      .innerJoin(ratePlans, eq(ratePlans.id, channelRatePlanMappings.ratePlanId))
      .where(
        and(
          eq(channelRatePlanMappings.channelId, channelId),
          eq(ratePlans.roomTypeId, roomTypeId),
          eq(ratePlans.isActive, true),
        ),
      );
  }

  async recordSyncJob(tx: Executor, job: SyncJobRecord): Promise<void> {
    await tx.insert(syncJobs).values({
      id: newId(),
      organizationId: job.organizationId,
      channelId: job.channelId,
      kind: job.kind,
      roomTypeId: job.roomTypeId,
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  }

  async recordConnectionTest(
    tx: Executor,
    channelId: string,
    at: Date,
    error: string | null,
  ): Promise<void> {
    await tx
      .update(channels)
      .set({
        // No status. A test says whether the credentials work, not whether the
        // hotel wants to sell here — and INACTIVE → ERROR would trip the
        // partial unique index on non-inactive channels.
        //
        // lastSyncAt is untouched too: nothing was synced. A green test on a
        // channel that has not pushed for a week must not make it look fresh.
        lastError: error,
        updatedAt: at,
      })
      .where(eq(channels.id, channelId));
  }

  async markSynced(tx: Executor, channelId: string, at: Date, error: string | null): Promise<void> {
    await tx
      .update(channels)
      .set({
        // Only a SUCCESSFUL push advances lastSyncAt. Otherwise a failing
        // channel would look freshly synced on the dashboard, which is exactly
        // the blindness that lets stale availability sell rooms.
        ...(error === null ? { lastSyncAt: at } : {}),
        lastError: error,
        status: error === null ? 'ACTIVE' : 'ERROR',
        updatedAt: at,
      })
      .where(eq(channels.id, channelId));
  }
}
