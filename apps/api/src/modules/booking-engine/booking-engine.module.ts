import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { FolioModule } from '../folio/folio.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { PublicPropertyResolver } from './application/public-property.resolver';
import { TakeDepositUseCase } from './application/take-deposit.usecase';
import { PAYMENT_GATEWAY } from './domain/payment-gateway';
import { OmiseGateway } from './infrastructure/omise.gateway';
import { BookingEngineController } from './interface/booking-engine.controller';

/**
 * The direct booking engine: the only part of the system a stranger can reach.
 *
 * It writes nothing of its own. Availability is the same query the front desk
 * uses, a booking is the same use case, and a deposit lands on the same folio —
 * so a guest booking online and a clerk taking one over the phone cannot end up
 * with differently-shaped reservations, and a price shown to a guest is the
 * price the hotel configured rather than a second implementation of it.
 *
 * The payment gateway is a port. Omise because this is Thailand-first (it
 * settles in THB and supports PromptPay); Stripe would be another adapter.
 */
@Module({
  imports: [AvailabilityModule, ReservationsModule, FolioModule],
  controllers: [BookingEngineController],
  providers: [
    PublicPropertyResolver,
    TakeDepositUseCase,
    { provide: PAYMENT_GATEWAY, useClass: OmiseGateway },
  ],
})
export class BookingEngineModule {}
