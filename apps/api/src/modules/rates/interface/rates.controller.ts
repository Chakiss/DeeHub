import { Body, Controller, Param, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { isIsoDate, toIsoDate } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { UpdateRatesUseCase } from '../application/update-rates.usecase';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form')
  .refine(isIsoDate, 'Not a real calendar date');

const updateSchema = z
  .object({
    ratePlanId: z.string().uuid(),
    from: isoDate,
    to: isoDate,
    daysOfWeek: z
      .array(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']))
      .min(1)
      .max(7)
      .optional(),
    prices: z
      .array(
        z
          .object({
            occupancy: z.number().int().min(1).max(20),
            // Integer minor units (ADR-0003): a decimal here is a caller bug.
            amount: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine((update) => update.to > update.from, {
    message: 'Range end must be after start',
    path: ['to'],
  });

const bulkSchema = z.object({ updates: z.array(updateSchema).min(1).max(50) }).strict();

type BulkBody = z.infer<typeof bulkSchema>;

@ApiTags('rates')
@Controller('properties/:propertyId/rates')
export class RatesController {
  constructor(private readonly updateRates: UpdateRatesUseCase) {}

  @Patch()
  @RequireCapability('rate:update')
  @ApiOperation({ summary: 'Bulk update prices over a date range' })
  async update(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(bulkSchema)) body: BulkBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.updateRates.execute(
      {
        propertyId,
        updates: body.updates.map((update) => ({
          ratePlanId: update.ratePlanId,
          from: toIsoDate(update.from),
          to: toIsoDate(update.to),
          ...(update.daysOfWeek ? { daysOfWeek: update.daysOfWeek } : {}),
          prices: update.prices,
        })),
      },
      actorFrom(request),
    );
  }
}
