import { Module } from '@nestjs/common';
import { UpdateRatesUseCase } from './application/update-rates.usecase';
import { DeleteRatesUseCase } from './application/delete-rates.usecase';
import { RATE_REPOSITORY } from './domain/rate.repository';
import { DrizzleRateRepository } from './infrastructure/drizzle-rate.repository';
import { RatesController } from './interface/rates.controller';

@Module({
  controllers: [RatesController],
  providers: [
    { provide: RATE_REPOSITORY, useClass: DrizzleRateRepository },
    UpdateRatesUseCase,
    DeleteRatesUseCase,
  ],
  exports: [RATE_REPOSITORY, UpdateRatesUseCase],
})
export class RatesModule {}
