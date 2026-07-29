import { Module } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from './domain/inventory.repository';
import { DrizzleInventoryRepository } from './infrastructure/drizzle-inventory.repository';

/**
 * Inventory bounded context.
 *
 * Exports only the repository port. Other modules ask for a hold; nothing
 * outside this module writes `booked` (ADR-0002).
 */
@Module({
  providers: [{ provide: INVENTORY_REPOSITORY, useClass: DrizzleInventoryRepository }],
  exports: [INVENTORY_REPOSITORY],
})
export class InventoryModule {}
