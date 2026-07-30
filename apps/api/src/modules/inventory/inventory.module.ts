import { Module } from '@nestjs/common';
import { ExpireHoldsUseCase } from './application/expire-holds.usecase';
import { ReconcileInventoryUseCase } from './application/reconcile-inventory.usecase';
import { INVENTORY_REPOSITORY } from './domain/inventory.repository';
import { DrizzleInventoryRepository } from './infrastructure/drizzle-inventory.repository';

/**
 * Inventory bounded context.
 *
 * Exports the repository port and the maintenance use cases. Other modules ask
 * for a hold; nothing outside this module writes `booked` (ADR-0002).
 */
@Module({
  providers: [
    { provide: INVENTORY_REPOSITORY, useClass: DrizzleInventoryRepository },
    ExpireHoldsUseCase,
    ReconcileInventoryUseCase,
  ],
  exports: [INVENTORY_REPOSITORY, ExpireHoldsUseCase, ReconcileInventoryUseCase],
})
export class InventoryModule {}
