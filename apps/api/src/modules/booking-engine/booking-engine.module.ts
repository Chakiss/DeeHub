import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { FolioModule } from '../folio/folio.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MediaModule } from '../media/media.module';
import { PropertiesModule } from '../properties/properties.module';
import { RatePlansModule } from '../rate-plans/rate-plans.module';
import { RatesModule } from '../rates/rates.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { RoomTypesModule } from '../room-types/room-types.module';
import { LowestRatesQuery } from './application/lowest-rates.query';
import { PublicBookingQuery } from './application/public-booking.query';
import { PublicCatalogQuery } from './application/public-catalog.query';
import { PublicPropertyResolver } from './application/public-property.resolver';
import { SettlePaymentUseCase } from './application/settle-payment.usecase';
import { StartPaymentUseCase } from './application/start-payment.usecase';
import { PAYMENT_GATEWAY } from './domain/payment-gateway';
import { PAYMENT_INTENT_REPOSITORY } from './domain/payment-intent.repository';
import { DrizzlePaymentIntentRepository } from './infrastructure/drizzle-payment-intent.repository';
import { OmiseGateway } from './infrastructure/omise.gateway';
import { BookingEngineController } from './interface/booking-engine.controller';
import { OmiseWebhookController } from './interface/omise-webhook.controller';

/**
 * The direct booking engine: the only part of the system a stranger can reach.
 *
 * It writes little of its own — a payment attempt, and nothing else.
 * Availability is the same query the front desk uses, a booking is the same
 * use case, and a payment lands on the same folio — so a guest booking online
 * and a clerk taking one over the phone cannot end up with differently-shaped
 * reservations, and a price shown to a guest is the price the hotel
 * configured rather than a second implementation of it.
 *
 * The payment gateway is a port. Omise because this is Thailand-first (it
 * settles in THB and supports PromptPay); Stripe would be another adapter.
 */
@Module({
  imports: [
    AvailabilityModule,
    ReservationsModule,
    FolioModule,
    PropertiesModule,
    RoomTypesModule,
    RatePlansModule,
    MediaModule,
    InventoryModule,
    RatesModule,
  ],
  controllers: [BookingEngineController, OmiseWebhookController],
  providers: [
    PublicPropertyResolver,
    PublicCatalogQuery,
    PublicBookingQuery,
    LowestRatesQuery,
    StartPaymentUseCase,
    SettlePaymentUseCase,
    { provide: PAYMENT_GATEWAY, useClass: OmiseGateway },
    { provide: PAYMENT_INTENT_REPOSITORY, useClass: DrizzlePaymentIntentRepository },
  ],
  exports: [PAYMENT_INTENT_REPOSITORY],
})
export class BookingEngineModule {}
