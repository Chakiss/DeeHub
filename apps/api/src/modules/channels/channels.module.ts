import { Module } from '@nestjs/common';
import { AesCredentialCipher, CREDENTIAL_CIPHER } from '../../common/crypto/credential-cipher';
import { InventoryModule } from '../inventory/inventory.module';
import { RatesModule } from '../rates/rates.module';
import { DeliverReservationUseCase } from './application/deliver-reservation.usecase';
import { PushAriUseCase } from './application/push-ari.usecase';
import { ReceiveWebhookUseCase } from './application/receive-webhook.usecase';
import { CHANNEL_REPOSITORY } from './domain/channel.repository';
import { ConnectorRegistry } from './domain/connector.registry';
import { DrizzleChannelRepository } from './infrastructure/drizzle-channel.repository';
import { MockOtaConnector } from './infrastructure/connectors/mock-ota.connector';
import { WebhooksController } from './interface/webhooks.controller';
import { ReservationsModule } from '../reservations/reservations.module';

/**
 * Channel bounded context: connector framework and the sync engine's
 * outbound half.
 *
 * Adding a real OTA means writing one adapter and adding it to the registry
 * factory below. Nothing else in the codebase changes — that is the whole point
 * of the port (architecture.md §6).
 */
@Module({
  imports: [InventoryModule, RatesModule, ReservationsModule],
  controllers: [WebhooksController],
  providers: [
    { provide: CREDENTIAL_CIPHER, useClass: AesCredentialCipher },
    { provide: CHANNEL_REPOSITORY, useClass: DrizzleChannelRepository },
    MockOtaConnector,
    {
      provide: ConnectorRegistry,
      inject: [MockOtaConnector],
      useFactory: (mockOta: MockOtaConnector): ConnectorRegistry =>
        new ConnectorRegistry([mockOta]),
    },
    PushAriUseCase,
    ReceiveWebhookUseCase,
    DeliverReservationUseCase,
  ],
  exports: [
    PushAriUseCase,
    ReceiveWebhookUseCase,
    DeliverReservationUseCase,
    ConnectorRegistry,
    CHANNEL_REPOSITORY,
    CREDENTIAL_CIPHER,
  ],
})
export class ChannelsModule {}
