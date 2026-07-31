import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import { newId } from '../../../common/ids';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { CREDENTIAL_CIPHER, type CredentialCipher } from '../../../common/crypto/credential-cipher';
import {
  channelRatePlanMappings,
  channelRoomTypeMappings,
  channels,
  ratePlans,
  roomTypes,
} from '../../../database/schema';
import { ConnectorRegistry } from '../domain/connector.registry';
import type { ChannelType } from '../domain/channel-connector';

export interface CreateChannelInput {
  readonly propertyId: string;
  readonly type: ChannelType;
  readonly name: string;
  readonly syncHorizonDays?: number;
  readonly credentials?: Record<string, string>;
}

export interface UpdateChannelInput {
  readonly propertyId: string;
  readonly channelId: string;
  readonly name?: string;
  readonly syncHorizonDays?: number;
  readonly status?: 'ACTIVE' | 'INACTIVE';
  /** Replaces the stored set wholesale. Never returned, never logged. */
  readonly credentials?: Record<string, string>;
}

export interface MappingInput {
  readonly localId: string;
  readonly externalId: string;
  readonly externalName?: string | null;
}

export interface ReplaceMappingsInput {
  readonly propertyId: string;
  readonly channelId: string;
  readonly roomTypes: readonly MappingInput[];
  readonly ratePlans: readonly MappingInput[];
}

/**
 * Channel administration (roadmap Phase 3).
 *
 * The connector framework, the sync engine and the webhook receiver have all
 * existed since Phase 3; there was no way to create a channel except by SQL.
 *
 * Two rules are enforced here rather than left to the operator:
 *
 * 1. A channel cannot be ACTIVATED until every active room type is mapped.
 *    An active channel with a missing mapping does not fail loudly — the ARI
 *    push skips that room type, so the OTA keeps selling stale availability
 *    and the first symptom is an overbooking.
 *
 * 2. Credentials are write-only. They go in encrypted and never come back out
 *    through the API.
 */
@Injectable()
export class ManageChannelUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher,
    private readonly connectors: ConnectorRegistry,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateChannelInput, actor: AuditActor): Promise<{ id: string }> {
    const tenant = requireTenant();

    // Refuse a type nothing can talk to. A channel whose connector does not
    // exist can be created, mapped and activated, and will simply never sync.
    if (!this.connectors.has(input.type)) {
      throw errors.validation(`No connector is implemented for ${input.type}`, {
        type: input.type,
        supported: this.connectors.supportedTypes(),
      });
    }

    return this.db.transaction(async (tx) => {
      const id = newId();
      await tx.insert(channels).values({
        id,
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        type: input.type,
        name: input.name,
        // Always INACTIVE: a channel created and instantly live would push
        // before anyone had a chance to map a single room type.
        status: 'INACTIVE',
        ...(input.credentials
          ? { credentialsEncrypted: this.cipher.encrypt(input.credentials) }
          : {}),
        ...(input.syncHorizonDays ? { syncHorizonDays: input.syncHorizonDays } : {}),
      });

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'channel.created',
        entityType: 'channel',
        entityId: id,
        // Note what is absent: the credentials themselves are never audited.
        after: {
          type: input.type,
          name: input.name,
          status: 'INACTIVE',
          credentialsProvided: Boolean(input.credentials),
        },
      });

      return { id };
    });
  }

  async update(input: UpdateChannelInput, actor: AuditActor): Promise<void> {
    const tenant = requireTenant();

    await this.db.transaction(async (tx) => {
      const existing = await this.load(tx, input.propertyId, input.channelId);

      if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
        await this.assertReadyToActivate(tx, input.propertyId, input.channelId);
      }

      await tx
        .update(channels)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.syncHorizonDays === undefined
            ? {}
            : { syncHorizonDays: input.syncHorizonDays }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.credentials
            ? { credentialsEncrypted: this.cipher.encrypt(input.credentials) }
            : {}),
          // Deactivating clears a stale failure so the health strip does not
          // keep reporting an error for a channel nobody is using.
          ...(input.status === 'INACTIVE' ? { lastError: null } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(channels.id, input.channelId), eq(channels.organizationId, tenant.organizationId)),
        );

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: input.status ? 'channel.status_changed' : 'channel.updated',
        entityType: 'channel',
        entityId: input.channelId,
        before: { name: existing.name, status: existing.status },
        after: {
          name: input.name ?? existing.name,
          status: input.status ?? existing.status,
          credentialsReplaced: Boolean(input.credentials),
        },
      });
    });
  }

  /**
   * Replace every mapping in one transaction.
   *
   * A replace rather than a patch: mappings are a set, and the unique indexes
   * on (channel, local) and (channel, external) mean an incremental edit can
   * collide with a row the same request is about to delete.
   */
  async replaceMappings(input: ReplaceMappingsInput, actor: AuditActor): Promise<void> {
    const tenant = requireTenant();

    await this.db.transaction(async (tx) => {
      await this.load(tx, input.propertyId, input.channelId);

      await this.assertBelongsToProperty(
        tx,
        input.propertyId,
        input.roomTypes.map((mapping) => mapping.localId),
        'roomType',
      );
      await this.assertBelongsToProperty(
        tx,
        input.propertyId,
        input.ratePlans.map((mapping) => mapping.localId),
        'ratePlan',
      );

      await tx
        .delete(channelRoomTypeMappings)
        .where(eq(channelRoomTypeMappings.channelId, input.channelId));
      await tx
        .delete(channelRatePlanMappings)
        .where(eq(channelRatePlanMappings.channelId, input.channelId));

      if (input.roomTypes.length > 0) {
        await tx.insert(channelRoomTypeMappings).values(
          input.roomTypes.map((mapping) => ({
            id: newId(),
            organizationId: tenant.organizationId,
            channelId: input.channelId,
            roomTypeId: mapping.localId,
            externalRoomId: mapping.externalId,
            externalRoomName: mapping.externalName ?? null,
          })),
        );
      }
      if (input.ratePlans.length > 0) {
        await tx.insert(channelRatePlanMappings).values(
          input.ratePlans.map((mapping) => ({
            id: newId(),
            organizationId: tenant.organizationId,
            channelId: input.channelId,
            ratePlanId: mapping.localId,
            externalRateId: mapping.externalId,
            externalRateName: mapping.externalName ?? null,
          })),
        );
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'channel.mappings_replaced',
        entityType: 'channel',
        entityId: input.channelId,
        after: {
          roomTypes: input.roomTypes.length,
          ratePlans: input.ratePlans.length,
        },
      });
    });
  }

  private async load(
    tx: Executor,
    propertyId: string,
    channelId: string,
  ): Promise<{ name: string; status: string }> {
    const organizationId = requireTenant().organizationId;
    const rows = await tx
      .select({ name: channels.name, status: channels.status })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.organizationId, organizationId),
          // A channel from another property is indistinguishable from one that
          // does not exist — a 403 here would confirm it exists.
          eq(channels.propertyId, propertyId),
        ),
      )
      .limit(1);

    const channel = rows[0];
    if (!channel) throw errors.notFound('Channel', channelId);
    return channel;
  }

  /** See rule 1 in the class comment: an unmapped active channel oversells. */
  private async assertReadyToActivate(
    tx: Executor,
    propertyId: string,
    channelId: string,
  ): Promise<void> {
    const organizationId = requireTenant().organizationId;

    const active = await tx
      .select({ id: roomTypes.id, name: roomTypes.name })
      .from(roomTypes)
      .where(
        and(
          eq(roomTypes.organizationId, organizationId),
          eq(roomTypes.propertyId, propertyId),
          eq(roomTypes.isActive, true),
        ),
      );

    if (active.length === 0) {
      throw errors.conflict('Cannot activate a channel for a property with no room types', {
        channelId,
      });
    }

    const mapped = await tx
      .select({ roomTypeId: channelRoomTypeMappings.roomTypeId })
      .from(channelRoomTypeMappings)
      .where(eq(channelRoomTypeMappings.channelId, channelId));

    const mappedIds = new Set(mapped.map((row) => row.roomTypeId));
    const unmapped = active.filter((roomType) => !mappedIds.has(roomType.id));

    if (unmapped.length > 0) {
      throw errors.conflict(
        'Every active room type must be mapped before this channel can be activated',
        { channelId, unmapped: unmapped.map((roomType) => roomType.name) },
      );
    }
  }

  /** Stops a mapping pointing at another property's room type or rate plan. */
  private async assertBelongsToProperty(
    tx: Executor,
    propertyId: string,
    ids: readonly string[],
    kind: 'roomType' | 'ratePlan',
  ): Promise<void> {
    if (ids.length === 0) return;

    const organizationId = requireTenant().organizationId;
    const table = kind === 'roomType' ? roomTypes : ratePlans;

    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.organizationId, organizationId), eq(table.propertyId, propertyId)));

    const known = new Set(rows.map((row) => row.id));
    const foreign = ids.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      throw errors.validation(`Mapping refers to a ${kind} outside this property`, { foreign });
    }
  }
}
