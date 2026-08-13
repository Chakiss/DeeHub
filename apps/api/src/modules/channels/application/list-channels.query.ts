import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  channelRatePlanMappings,
  channelReservations,
  channelRoomTypeMappings,
  channels,
  ratePlans,
  roomTypes,
  syncJobs,
} from '../../../database/schema';

export interface ChannelSummary {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly status: string;
  readonly syncHorizonDays: number;
  readonly hasCredentials: boolean;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
  /** How much of the property is actually reachable through this channel. */
  readonly mappedRoomTypes: number;
  readonly totalRoomTypes: number;
  readonly mappedRatePlans: number;
  readonly createdAt: string;
}

export interface ChannelMapping {
  readonly id: string;
  readonly localId: string;
  readonly localName: string;
  readonly localCode: string;
  readonly externalId: string;
  readonly externalName: string | null;
}

export interface ChannelRatePlanMapping extends ChannelMapping {
  /**
   * Markup applied before this plan's price is pushed, in basis points
   * (10000 = ×1.0). Returned so the screen can show what an OTA is actually
   * quoted — a markup nobody can see is a markup nobody can check.
   */
  readonly rateMultiplierBp: number;
}

export interface SyncJobSummary {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface InboundBookingSummary {
  readonly id: string;
  readonly externalReservationId: string;
  readonly status: string;
  readonly error: string | null;
  readonly receivedAt: string;
  readonly reservationId: string | null;
}

export interface ChannelDetail extends ChannelSummary {
  readonly roomTypeMappings: readonly ChannelMapping[];
  readonly ratePlanMappings: readonly ChannelRatePlanMapping[];
  /** Everything sellable, so the UI can show what is NOT yet mapped. */
  readonly availableRoomTypes: readonly { id: string; code: string; name: string }[];
  readonly availableRatePlans: readonly {
    id: string;
    roomTypeId: string;
    code: string;
    name: string;
  }[];
  readonly recentJobs: readonly SyncJobSummary[];
  readonly recentInbound: readonly InboundBookingSummary[];
}

const RECENT_LIMIT = 20;

/**
 * Read model for channel administration.
 *
 * Credentials are NEVER part of this shape — only whether any are stored. The
 * column is write-only by design (docs/security.md); returning a decrypted
 * secret to a browser would undo the reason it is encrypted at rest.
 */
@Injectable()
export class ListChannelsQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(propertyId: string): Promise<readonly ChannelSummary[]> {
    const organizationId = requireOrganizationId();

    const totalRoomTypes = await this.countRoomTypes(propertyId);

    const rows = await this.db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        status: channels.status,
        syncHorizonDays: channels.syncHorizonDays,
        hasCredentials: sql<boolean>`${channels.credentialsEncrypted} IS NOT NULL`,
        lastSyncAt: channels.lastSyncAt,
        lastError: channels.lastError,
        createdAt: channels.createdAt,
        // Qualified identifiers on purpose: Drizzle renders an embedded column
        // as a bare "id", and inside these subqueries the mapping tables also
        // have an "id", so the inner scope would silently win.
        mappedRoomTypes: sql<number>`(
          SELECT COUNT(*)::int FROM channel_room_type_mappings m
           WHERE m.channel_id = "channels"."id"
        )`,
        mappedRatePlans: sql<number>`(
          SELECT COUNT(*)::int FROM channel_rate_plan_mappings m
           WHERE m.channel_id = "channels"."id"
        )`,
      })
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.propertyId, propertyId)))
      .orderBy(channels.name);

    return rows.map((row) => ({
      ...row,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      totalRoomTypes,
    }));
  }

  async byId(propertyId: string, channelId: string): Promise<ChannelDetail | null> {
    const summaries = await this.list(propertyId);
    const summary = summaries.find((candidate) => candidate.id === channelId);
    if (!summary) return null;

    const organizationId = requireOrganizationId();

    const [roomTypeRows, ratePlanRows, allRoomTypes, allRatePlans, jobs, inbound] =
      await Promise.all([
        this.db
          .select({
            id: channelRoomTypeMappings.id,
            localId: channelRoomTypeMappings.roomTypeId,
            localName: roomTypes.name,
            localCode: roomTypes.code,
            externalId: channelRoomTypeMappings.externalRoomId,
            externalName: channelRoomTypeMappings.externalRoomName,
          })
          .from(channelRoomTypeMappings)
          .innerJoin(roomTypes, eq(roomTypes.id, channelRoomTypeMappings.roomTypeId))
          .where(eq(channelRoomTypeMappings.channelId, channelId))
          .orderBy(roomTypes.name),

        this.db
          .select({
            id: channelRatePlanMappings.id,
            localId: channelRatePlanMappings.ratePlanId,
            localName: ratePlans.name,
            localCode: ratePlans.code,
            externalId: channelRatePlanMappings.externalRateId,
            externalName: channelRatePlanMappings.externalRateName,
            rateMultiplierBp: channelRatePlanMappings.rateMultiplierBp,
          })
          .from(channelRatePlanMappings)
          .innerJoin(ratePlans, eq(ratePlans.id, channelRatePlanMappings.ratePlanId))
          .where(eq(channelRatePlanMappings.channelId, channelId))
          .orderBy(ratePlans.name),

        this.db
          .select({ id: roomTypes.id, code: roomTypes.code, name: roomTypes.name })
          .from(roomTypes)
          .where(
            and(
              eq(roomTypes.organizationId, organizationId),
              eq(roomTypes.propertyId, propertyId),
              eq(roomTypes.isActive, true),
            ),
          )
          .orderBy(roomTypes.sortOrder, roomTypes.name),

        this.db
          .select({
            id: ratePlans.id,
            roomTypeId: ratePlans.roomTypeId,
            code: ratePlans.code,
            name: ratePlans.name,
          })
          .from(ratePlans)
          .where(
            and(
              eq(ratePlans.organizationId, organizationId),
              eq(ratePlans.propertyId, propertyId),
              eq(ratePlans.isActive, true),
            ),
          )
          .orderBy(ratePlans.name),

        this.db
          .select({
            id: syncJobs.id,
            kind: syncJobs.kind,
            status: syncJobs.status,
            attempts: syncJobs.attempts,
            lastError: syncJobs.lastError,
            dateFrom: syncJobs.dateFrom,
            dateTo: syncJobs.dateTo,
            startedAt: syncJobs.startedAt,
            completedAt: syncJobs.completedAt,
          })
          .from(syncJobs)
          .where(eq(syncJobs.channelId, channelId))
          .orderBy(desc(syncJobs.scheduledAt))
          .limit(RECENT_LIMIT),

        this.db
          .select({
            id: channelReservations.id,
            externalReservationId: channelReservations.externalReservationId,
            status: channelReservations.status,
            error: channelReservations.error,
            receivedAt: channelReservations.receivedAt,
            reservationId: channelReservations.reservationId,
          })
          .from(channelReservations)
          .where(eq(channelReservations.channelId, channelId))
          .orderBy(desc(channelReservations.receivedAt))
          .limit(RECENT_LIMIT),
      ]);

    return {
      ...summary,
      roomTypeMappings: roomTypeRows,
      ratePlanMappings: ratePlanRows,
      availableRoomTypes: allRoomTypes,
      availableRatePlans: allRatePlans,
      recentJobs: jobs.map((job) => ({
        ...job,
        startedAt: job.startedAt?.toISOString() ?? null,
        completedAt: job.completedAt?.toISOString() ?? null,
      })),
      recentInbound: inbound.map((row) => ({
        ...row,
        receivedAt: row.receivedAt.toISOString(),
      })),
    };
  }

  private async countRoomTypes(propertyId: string): Promise<number> {
    const organizationId = requireOrganizationId();
    const rows = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(roomTypes)
      .where(
        and(
          eq(roomTypes.organizationId, organizationId),
          eq(roomTypes.propertyId, propertyId),
          eq(roomTypes.isActive, true),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}
