import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { RoomTypesModule } from '../room-types/room-types.module';
import { CreateRatePlanUseCase } from './application/create-rate-plan.usecase';
import { UpdateRatePlanUseCase } from './application/update-rate-plan.usecase';
import { RATE_PLAN_REPOSITORY } from './domain/rate-plan.repository';
import { DrizzleRatePlanRepository } from './infrastructure/drizzle-rate-plan.repository';
import { RatePlansController } from './interface/rate-plans.controller';

@Module({
  // RoomTypesModule so a new plan can be checked against a room type in THIS
  // tenant's property; InventoryModule for the shared audit-actor helper the
  // other write controllers use.
  imports: [RoomTypesModule, InventoryModule],
  controllers: [RatePlansController],
  providers: [
    { provide: RATE_PLAN_REPOSITORY, useClass: DrizzleRatePlanRepository },
    CreateRatePlanUseCase,
    UpdateRatePlanUseCase,
  ],
  exports: [RATE_PLAN_REPOSITORY],
})
export class RatePlansModule {}
