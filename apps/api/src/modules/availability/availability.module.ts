import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { RatesModule } from '../rates/rates.module';
import { SearchAvailabilityQuery } from './application/search-availability.query';
import { AvailabilityController } from './interface/availability.controller';

/**
 * Availability search sits ABOVE Inventory and Rates and consumes both, which
 * keeps the dependency direction in docs/domain-model.md §2 intact — neither of
 * those contexts learns about the other.
 */
@Module({
  imports: [InventoryModule, RatesModule],
  controllers: [AvailabilityController],
  providers: [SearchAvailabilityQuery],
  exports: [SearchAvailabilityQuery],
})
export class AvailabilityModule {}
