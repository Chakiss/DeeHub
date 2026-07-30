import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { LinkGuestUseCase } from './application/link-guest.usecase';
import { GUEST_REPOSITORY } from './domain/guest.repository';
import { DrizzleGuestRepository } from './infrastructure/drizzle-guest.repository';
import { GuestsController } from './interface/guests.controller';

/**
 * Guest profiles.
 *
 * Exports LinkGuestUseCase so the booking path can attach a guest inside its
 * own transaction. Depends on nothing in reservations — the arrow points one
 * way, or the two modules could not be loaded independently.
 */
@Module({
  imports: [InventoryModule],
  controllers: [GuestsController],
  providers: [{ provide: GUEST_REPOSITORY, useClass: DrizzleGuestRepository }, LinkGuestUseCase],
  exports: [GUEST_REPOSITORY, LinkGuestUseCase],
})
export class GuestsModule {}
