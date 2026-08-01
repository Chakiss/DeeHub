import { Inject, Injectable, Logger } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { ConnectorRegistry } from '../domain/connector.registry';
import { CHANNEL_REPOSITORY, type ChannelRepository } from '../domain/channel.repository';
import type { HealthResult } from '../domain/channel-connector';

export interface TestChannelConnectionInput {
  readonly propertyId: string;
  readonly channelId: string;
}

/**
 * Ask a channel whether it can hear us.
 *
 * `testConnection` has been on the connector port since the framework was
 * written and nothing ever called it, so the only way to find out that a
 * credential was wrong was to activate the channel and wait for a booking that
 * never arrived. This is the button that answers the question first.
 *
 * **A failed test is a 200, not an error.** "Agoda rejected the API key" is a
 * successful answer to the question asked — the request worked, the credential
 * did not — and an HTTP error would make the dashboard show a network problem
 * where there is a configuration one.
 *
 * The result is written to the channel's health strip, so the failure is still
 * visible after the operator navigates away — but it does NOT change the
 * channel's STATUS. A test is diagnostic: an inactive channel that fails one is
 * switched off, not broken, and saying otherwise would also collide with the
 * partial unique index that permits one non-inactive channel per type per
 * property. Status belongs to the operator and to the sync engine.
 */
@Injectable()
export class TestChannelConnectionUseCase {
  private readonly logger = new Logger(TestChannelConnectionUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepository,
    private readonly registry: ConnectorRegistry,
    private readonly audit: AuditService,
  ) {}

  async execute(input: TestChannelConnectionInput, actor: AuditActor): Promise<HealthResult> {
    const tenant = requireTenant();

    const channel = await this.channels.findById(this.db, input.channelId);
    if (!channel || channel.propertyId !== input.propertyId) {
      throw errors.notFound('Channel', input.channelId);
    }

    const context = await this.channels.loadContext(this.db, input.channelId);
    if (!context) throw errors.notFound('Channel', input.channelId);

    const connector = this.registry.get(channel.type);

    let result: HealthResult;
    try {
      result = await connector.testConnection(context);
    } catch (error) {
      /*
       * A connector that throws rather than returning a HealthResult is a bug
       * in that adapter — the port says it answers. Turning it into a failed
       * health result rather than a 500 keeps one badly-behaved connector from
       * looking like the platform is broken, and the detail says what happened.
       */
      this.logger.warn(`Connector ${channel.type} threw during testConnection: ${String(error)}`);
      result = { ok: false, detail: String(error).slice(0, 500), latencyMs: 0 };
    }

    await this.db.transaction(async (tx) => {
      await this.channels.recordConnectionTest(
        tx,
        channel.id,
        new Date(),
        result.ok ? null : result.detail.slice(0, 1_000),
      );

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: channel.propertyId,
        actor,
        action: 'channel.connection_tested',
        entityType: 'channel',
        entityId: channel.id,
        // The outcome and how long it took, never the credentials that were
        // used to get it.
        after: { ok: result.ok, detail: result.detail, latencyMs: result.latencyMs },
      });
    });

    return result;
  }
}
