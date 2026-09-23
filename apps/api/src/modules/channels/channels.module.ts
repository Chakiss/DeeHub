import { Module } from '@nestjs/common';
import { AesCredentialCipher, CREDENTIAL_CIPHER } from '../../common/crypto/credential-cipher';
import { InventoryModule } from '../inventory/inventory.module';
import { RatesModule } from '../rates/rates.module';
import { DeliverReservationUseCase } from './application/deliver-reservation.usecase';
import { ForceSyncUseCase } from './application/force-sync.usecase';
import { PushAriUseCase } from './application/push-ari.usecase';
import { TestChannelConnectionUseCase } from './application/test-channel-connection.usecase';
import { ReceiveWebhookUseCase } from './application/receive-webhook.usecase';
import { ListChannelsQuery } from './application/list-channels.query';
import { ManageChannelUseCase } from './application/manage-channel.usecase';
import { CHANNEL_REPOSITORY } from './domain/channel.repository';
import { ConnectorRegistry } from './domain/connector.registry';
import { DrizzleChannelRepository } from './infrastructure/drizzle-channel.repository';
import { MockOtaConnector } from './infrastructure/connectors/mock-ota.connector';
import { GoogleHotelConnector } from './infrastructure/connectors/google-hotel/google-hotel.connector';
import { PropertiesModule } from '../properties/properties.module';
import { RoomTypesModule } from '../room-types/room-types.module';
import { RatePlansModule } from '../rate-plans/rate-plans.module';
import { DrainAriRequestsUseCase } from './application/drain-ari-requests.usecase';
import { GoogleFeedController } from './interface/google-feed.controller';
import { WebhooksController } from './interface/webhooks.controller';
import { ChannelsController } from './interface/channels.controller';
import { ReservationsModule } from '../reservations/reservations.module';
import { BookingSourcesModule } from '../booking-sources/booking-sources.module';

/**
 * Channel bounded context: connector framework and the sync engine's
 * outbound half.
 *
 * Adding a real OTA means writing one adapter and adding it to the registry
 * factory below. Nothing else in the codebase changes — that is the whole point
 * of the port (architecture.md §6).
 */
@Module({
  // BookingSourcesModule so a delivered booking lands under the label the
  // desk has been using by hand for that OTA.
  imports: [
    InventoryModule,
    RatesModule,
    ReservationsModule,
    BookingSourcesModule,
    // Tax settings for the all-in price a metasearch shows, and the room and
    // rate plan catalogue Google needs described before it takes a price.
    PropertiesModule,
    RoomTypesModule,
    RatePlansModule,
  ],
  controllers: [WebhooksController, ChannelsController, GoogleFeedController],
  providers: [
    { provide: CREDENTIAL_CIPHER, useClass: AesCredentialCipher },
    { provide: CHANNEL_REPOSITORY, useClass: DrizzleChannelRepository },
    MockOtaConnector,
    GoogleHotelConnector,
    {
      provide: ConnectorRegistry,
      inject: [MockOtaConnector, GoogleHotelConnector],
      useFactory: (mockOta: MockOtaConnector, google: GoogleHotelConnector): ConnectorRegistry =>
        new ConnectorRegistry([mockOta, google]),
    },
    PushAriUseCase,
    DrainAriRequestsUseCase,
    ReceiveWebhookUseCase,
    DeliverReservationUseCase,
    ListChannelsQuery,
    ManageChannelUseCase,
    TestChannelConnectionUseCase,
    ForceSyncUseCase,
  ],
  exports: [
    PushAriUseCase,
    DrainAriRequestsUseCase,
    ReceiveWebhookUseCase,
    DeliverReservationUseCase,
    ConnectorRegistry,
    CHANNEL_REPOSITORY,
    CREDENTIAL_CIPHER,
  ],
})
export class ChannelsModule {}
