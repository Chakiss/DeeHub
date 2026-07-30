import { Module } from '@nestjs/common';
import { ExpireHoldsUseCase } from './application/expire-holds.usecase';
import { GetInventoryGridQuery } from './application/get-inventory-grid.query';
import { ReconcileInventoryUseCase } from './application/reconcile-inventory.usecase';
import { UpdateInventoryUseCase } from './application/update-inventory.usecase';
import { INVENTORY_REPOSITORY } from './domain/inventory.repository';
import { DrizzleInventoryRepository } from './infrastructure/drizzle-inventory.repository';
import { InventoryController } from './interface/inventory.controller';

/**
 * Inventory bounded context.
 *
 * Exports the repository port and its use cases. Other modules ask for a hold;
 * nothing outside this module writes `booked` (ADR-0002).
 */
@Module({
  controllers: [InventoryController],
  providers: [
    { provide: INVENTORY_REPOSITORY, useClass: DrizzleInventoryRepository },
    ExpireHoldsUseCase,
    ReconcileInventoryUseCase,
    UpdateInventoryUseCase,
    GetInventoryGridQuery,
  ],
  exports: [
    INVENTORY_REPOSITORY,
    ExpireHoldsUseCase,
    ReconcileInventoryUseCase,
    UpdateInventoryUseCase,
    GetInventoryGridQuery,
  ],
})
export class InventoryModule {}
