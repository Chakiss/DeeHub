import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PropertiesModule } from '../properties/properties.module';
import { ManageBookingSourcesUseCase } from './application/manage-booking-sources.usecase';
import { BOOKING_SOURCE_REPOSITORY } from './domain/booking-source.repository';
import { DrizzleBookingSourceRepository } from './infrastructure/drizzle-booking-source.repository';
import { BookingSourcesController } from './interface/booking-sources.controller';

/**
 * Booking sources: the OTAs and agents a property takes bookings from, as
 * labels the desk picks and reports group by (ADR-0009).
 *
 * Exports the port only. Reservations read a source to check it belongs to
 * the property and matches the booking's category; channel delivery reads
 * one by connector type so a connector's bookings land under the label the
 * desk already uses.
 */
@Module({
  // PropertiesModule to check the property is this tenant's; InventoryModule
  // for the shared audit-actor helper.
  imports: [PropertiesModule, InventoryModule],
  controllers: [BookingSourcesController],
  providers: [
    { provide: BOOKING_SOURCE_REPOSITORY, useClass: DrizzleBookingSourceRepository },
    ManageBookingSourcesUseCase,
  ],
  exports: [BOOKING_SOURCE_REPOSITORY],
})
export class BookingSourcesModule {}
