import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import type { AuditActor } from '../../../common/audit/audit.service';
import { GetInventoryGridQuery } from '../application/get-inventory-grid.query';
import { UpdateInventoryUseCase } from '../application/update-inventory.usecase';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form')
  .refine(isIsoDate, 'Not a real calendar date');

const dayOfWeek = z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

const updateSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    from: isoDate,
    to: isoDate,
    daysOfWeek: z.array(dayOfWeek).min(1).max(7).optional(),
    allotment: z.number().int().min(0).max(9999).optional(),
    stopSell: z.boolean().optional(),
    minStay: z.number().int().min(1).max(365).optional(),
    maxStay: z.number().int().min(1).max(365).nullable().optional(),
    closedToArrival: z.boolean().optional(),
    closedToDeparture: z.boolean().optional(),
  })
  .strict()
  .refine((update) => update.to > update.from, {
    message: 'Range end must be after start',
    path: ['to'],
  });

const bulkUpdateSchema = z.object({ updates: z.array(updateSchema).min(1).max(50) }).strict();

type BulkUpdateBody = z.infer<typeof bulkUpdateSchema>;

/** A year at a time is plenty for a calendar and bounds the response size. */
const MAX_RANGE_DAYS = 400;

@ApiTags('inventory')
@Controller('properties/:propertyId/inventory')
export class InventoryController {
  constructor(
    private readonly grid: GetInventoryGridQuery,
    private readonly updateInventory: UpdateInventoryUseCase,
  ) {}

  @Get()
  @RequireCapability('inventory:read')
  @ApiOperation({ summary: 'Inventory calendar grid' })
  async getGrid(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('roomTypeIds') roomTypeIds?: string,
  ) {
    const range = this.parseRange(from, to);
    return this.grid.execute(
      propertyId,
      range.from,
      range.to,
      roomTypeIds ? roomTypeIds.split(',').filter(Boolean) : [],
    );
  }

  @Patch()
  @RequireCapability('inventory:update')
  @ApiOperation({ summary: 'Bulk update allotment and restrictions over a date range' })
  async update(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(bulkUpdateSchema)) body: BulkUpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.updateInventory.execute(
      {
        propertyId,
        updates: body.updates.map((update) => ({
          roomTypeId: update.roomTypeId,
          from: toIsoDate(update.from),
          to: toIsoDate(update.to),
          ...(update.daysOfWeek ? { daysOfWeek: update.daysOfWeek } : {}),
          ...(update.allotment === undefined ? {} : { allotment: update.allotment }),
          ...(update.stopSell === undefined ? {} : { stopSell: update.stopSell }),
          ...(update.minStay === undefined ? {} : { minStay: update.minStay }),
          ...(update.maxStay === undefined ? {} : { maxStay: update.maxStay }),
          ...(update.closedToArrival === undefined
            ? {}
            : { closedToArrival: update.closedToArrival }),
          ...(update.closedToDeparture === undefined
            ? {}
            : { closedToDeparture: update.closedToDeparture }),
        })),
      },
      actorFrom(request),
    );
  }

  private parseRange(from: string, to: string): { from: IsoDate; to: IsoDate } {
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw errors.validation('from and to must be calendar dates in YYYY-MM-DD form');
    }
    const start = toIsoDate(from);
    const end = toIsoDate(to);
    if (end <= start) {
      throw errors.validation('to must be after from');
    }
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    );
    if (days > MAX_RANGE_DAYS) {
      throw errors.validation(`Range must not exceed ${String(MAX_RANGE_DAYS)} days`, { days });
    }
    return { from: start, to: end };
  }
}

export function actorFrom(request: AuthenticatedRequest): AuditActor {
  const principal = request.principal;
  return {
    type: 'USER',
    id: principal?.id ?? null,
    label: principal?.email ?? 'unknown',
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: (request.headers['x-request-id'] as string | undefined) ?? null,
  };
}
