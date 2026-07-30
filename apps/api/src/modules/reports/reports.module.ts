import { Module } from '@nestjs/common';
import { GetPerformanceQuery } from './application/get-performance.query';
import { ReportsController } from './interface/reports.controller';

/** Read-only derivations over reservations and inventory. Owns no tables. */
@Module({
  controllers: [ReportsController],
  providers: [GetPerformanceQuery],
  exports: [GetPerformanceQuery],
})
export class ReportsModule {}
