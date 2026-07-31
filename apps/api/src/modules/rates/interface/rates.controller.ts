import { Body, Controller, Delete, HttpCode, Param, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { isIsoDate, toIsoDate } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { UpdateRatesUseCase } from '../application/update-rates.usecase';
import { DeleteRatesUseCase } from '../application/delete-rates.usecase';

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

/**
 * Removing prices, deliberately NOT expressed as `amount: null` on the update
 * schema above.
 *
 * A night with no price cannot be sold at all, which is a different act from
 * changing a number — and an empty form field serialising to null must never
 * silently take a season off sale.
 */
const deletionSchema = z
  .object({
    ratePlanId: z.string().uuid(),
    from: isoDate,
    to: isoDate,
    daysOfWeek: z
      .array(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']))
      .min(1)
      .max(7)
      .optional(),
    /** Absent removes every occupancy; the usual slip is pricing the wrong one. */
    occupancies: z.array(z.number().int().min(1).max(20)).min(1).max(20).optional(),
  })
  .strict()
  .refine((deletion) => deletion.to > deletion.from, {
    message: 'Range end must be after start',
    path: ['to'],
  });

const bulkDeleteSchema = z.object({ deletions: z.array(deletionSchema).min(1).max(50) }).strict();

type BulkBody = z.infer<typeof bulkSchema>;
type BulkDeleteBody = z.infer<typeof bulkDeleteSchema>;

@ApiTags('rates')
@Controller('properties/:propertyId/rates')
export class RatesController {
  constructor(
    private readonly updateRates: UpdateRatesUseCase,
    private readonly deleteRates: DeleteRatesUseCase,
  ) {}

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

  @Delete()
  @HttpCode(200)
  // Same capability as setting a price: mis-pricing a season and un-pricing it
  // are equally commercial, and a separate one would need a role-bundle change.
  @RequireCapability('rate:update')
  @ApiOperation({ summary: 'Remove prices over a date range' })
  async remove(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(bulkDeleteSchema)) body: BulkDeleteBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.deleteRates.execute(
      {
        propertyId,
        deletions: body.deletions.map((deletion) => ({
          ratePlanId: deletion.ratePlanId,
          from: toIsoDate(deletion.from),
          to: toIsoDate(deletion.to),
          ...(deletion.daysOfWeek ? { daysOfWeek: deletion.daysOfWeek } : {}),
          ...(deletion.occupancies ? { occupancies: deletion.occupancies } : {}),
        })),
      },
      actorFrom(request),
    );
  }
}
