import { Module } from '@nestjs/common';
import { RATE_REPOSITORY } from './domain/rate.repository';
import { DrizzleRateRepository } from './infrastructure/drizzle-rate.repository';

@Module({
  providers: [{ provide: RATE_REPOSITORY, useClass: DrizzleRateRepository }],
  exports: [RATE_REPOSITORY],
})
export class RatesModule {}
