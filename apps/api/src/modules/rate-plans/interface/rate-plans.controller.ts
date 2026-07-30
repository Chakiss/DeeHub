import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { DATABASE, type Database } from '../../../database/database.module';
import { CreateRatePlanUseCase } from '../application/create-rate-plan.usecase';
import { UpdateRatePlanUseCase } from '../application/update-rate-plan.usecase';
import {
  MEAL_PLANS,
  RATE_PLAN_REPOSITORY,
  type RatePlanRecord,
  type RatePlanRepository,
} from '../domain/rate-plan.repository';

const code = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphen or underscore');

const createSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    code,
    name: z.string().trim().min(1).max(120),
    mealPlan: z.enum(MEAL_PLANS).default('ROOM_ONLY'),
    isRefundable: z.boolean().default(true),
  })
  .strict();

// Neither code nor roomTypeId appear: both are fixed after creation.
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    mealPlan: z.enum(MEAL_PLANS).optional(),
    isRefundable: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

type CreateBody = z.infer<typeof createSchema>;
type UpdateBody = z.infer<typeof updateSchema>;

@ApiTags('rate-plans')
@Controller('properties/:propertyId/rate-plans')
export class RatePlansController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_PLAN_REPOSITORY) private readonly repo: RatePlanRepository,
    private readonly create: CreateRatePlanUseCase,
    private readonly update: UpdateRatePlanUseCase,
  ) {}

  @Get()
  @RequireCapability('rateplan:read')
  @ApiOperation({ summary: 'Rate plans at a property' })
  async getAll(@Param('propertyId') propertyId: string) {
    const rows = await this.repo.list(this.db, propertyId);
    return { items: rows.map((row) => present(row)) };
  }

  @Post()
  @RequireCapability('rateplan:create')
  @ApiOperation({ summary: 'Create a rate plan for a room type' })
  async createOne(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(createSchema)) body: CreateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(await this.create.execute({ propertyId, ...body }, actorFrom(request)));
  }

  // No DELETE: rate_days and every reservation priced from this plan reference
  // it. isActive: false stops it being sold and quoted.
  @Patch(':ratePlanId')
  @RequireCapability('rateplan:update')
  @ApiOperation({ summary: 'Update a rate plan, or deactivate it with isActive: false' })
  async updateOne(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.update.execute({ propertyId, ratePlanId, fields: body }, actorFrom(request)),
    );
  }
}

function present(row: RatePlanRecord) {
  return {
    id: row.id,
    roomTypeId: row.roomTypeId,
    code: row.code,
    name: row.name,
    mealPlan: row.mealPlan,
    isRefundable: row.isRefundable,
    isActive: row.isActive,
  };
}
