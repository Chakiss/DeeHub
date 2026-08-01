import { Module } from '@nestjs/common';
import { CaptureOtbSnapshotUseCase } from './application/capture-otb-snapshot.usecase';
import { GetPerformanceQuery } from './application/get-performance.query';
import { GetPickupQuery } from './application/get-pickup.query';
import { ReportsController } from './interface/reports.controller';

/**
 * Derivations over reservations and inventory.
 *
 * Owns one table, `otb_snapshots`, and only because pickup cannot be derived:
 * live rows do not remember when they arrived. Everything else here reads.
 */
@Module({
  controllers: [ReportsController],
  providers: [GetPerformanceQuery, GetPickupQuery, CaptureOtbSnapshotUseCase],
  exports: [GetPerformanceQuery, GetPickupQuery, CaptureOtbSnapshotUseCase],
})
export class ReportsModule {}
