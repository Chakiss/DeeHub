import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PropertiesModule } from '../properties/properties.module';
import { RatesModule } from '../rates/rates.module';
import { CancelReservationUseCase } from './application/cancel-reservation.usecase';
import { CreateReservationUseCase } from './application/create-reservation.usecase';
import { GetReservationQuery } from './application/get-reservation.query';
import { RESERVATION_REPOSITORY } from './domain/reservation.repository';
import { DrizzleReservationRepository } from './infrastructure/drizzle-reservation.repository';
import { ReservationsController } from './interface/reservations.controller';

/**
 * Reservations bounded context.
 *
 * Depends on Inventory, Properties and Rates through their exported ports —
 * never on their internals. The dependency direction matches the context map
 * in docs/domain-model.md §2.
 */
@Module({
  imports: [InventoryModule, PropertiesModule, RatesModule],
  controllers: [ReservationsController],
  providers: [
    { provide: RESERVATION_REPOSITORY, useClass: DrizzleReservationRepository },
    CreateReservationUseCase,
    CancelReservationUseCase,
    GetReservationQuery,
  ],
  exports: [CreateReservationUseCase, CancelReservationUseCase, GetReservationQuery],
})
export class ReservationsModule {}
