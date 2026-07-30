import { Injectable } from '@nestjs/common';
import { DomainError } from '@deehub/shared';
import type { ChannelConnector, ChannelType } from './channel-connector';

/**
 * Resolves a connector by channel type at runtime.
 *
 * The sync engine asks the registry for a connector and never names an OTA.
 * Adding Agoda is registering one more adapter — no change to Inventory,
 * Reservations, or the worker.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<ChannelType, ChannelConnector>();

  constructor(connectors: readonly ChannelConnector[] = []) {
    for (const connector of connectors) this.register(connector);
  }

  register(connector: ChannelConnector): void {
    if (this.connectors.has(connector.type)) {
      throw new Error(`A connector is already registered for ${connector.type}`);
    }
    this.connectors.set(connector.type, connector);
  }

  get(type: ChannelType): ChannelConnector {
    const connector = this.connectors.get(type);
    if (!connector) {
      // A channel row exists for a type we cannot talk to. Loud, because the
      // alternative is silently never syncing that channel.
      throw new DomainError('INTERNAL_ERROR', `No connector registered for channel type ${type}`);
    }
    return connector;
  }

  has(type: ChannelType): boolean {
    return this.connectors.has(type);
  }

  supportedTypes(): readonly ChannelType[] {
    return [...this.connectors.keys()];
  }
}
