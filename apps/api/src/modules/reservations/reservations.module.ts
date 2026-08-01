import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PropertiesModule } from '../properties/properties.module';
import { RatesModule } from '../rates/rates.module';
import { CancelReservationUseCase } from './application/cancel-reservation.usecase';
import { CheckInUseCase } from './application/check-in.usecase';
import { CheckOutUseCase } from './application/check-out.usecase';
import { CreateReservationUseCase } from './application/create-reservation.usecase';
import { FolioModule } from '../folio/folio.module';
import { ExtendStayUseCase } from './application/extend-stay.usecase';
import { ShortenStayUseCase } from './application/shorten-stay.usecase';
import { GetReservationQuery } from './application/get-reservation.query';
import { ListReservationsQuery } from './application/list-reservations.query';
import { ModifyStayUseCase } from './application/modify-stay.usecase';
import { PlanStayService } from './application/plan-stay.service';
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
  // FolioModule for the outstanding balance at check-out: letting a guest walk
  // out is the last moment anybody can ask them for money.
  imports: [InventoryModule, PropertiesModule, RatesModule, GuestsModule, FolioModule],
  controllers: [ReservationsController],
  providers: [
    { provide: RESERVATION_REPOSITORY, useClass: DrizzleReservationRepository },
    // Shared by create, modify and extend: one place that holds inventory and
    // freezes prices.
    PlanStayService,
    CreateReservationUseCase,
    ModifyStayUseCase,
    ExtendStayUseCase,
    ShortenStayUseCase,
    CancelReservationUseCase,
    CheckInUseCase,
    CheckOutUseCase,
    GetReservationQuery,
    ListReservationsQuery,
  ],
  exports: [
    CreateReservationUseCase,
    ModifyStayUseCase,
    ExtendStayUseCase,
    ShortenStayUseCase,
    CancelReservationUseCase,
    GetReservationQuery,
    ListReservationsQuery,
  ],
})
export class ReservationsModule {}
