import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireCapability } from '../../../common/guards/auth.guard';
import { ListAuditQuery } from '../application/list-audit.query';

@ApiTags('audit')
@Controller('properties/:propertyId/audit')
export class AuditController {
  constructor(private readonly list: ListAuditQuery) {}

  @Get()
  @RequireCapability('audit:read')
  @ApiOperation({ summary: 'Who changed what, newest first' })
  async getAll(
    @Param('propertyId') propertyId: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.list.execute({
      propertyId,
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(cursor ? { cursor } : {}),
      // Clamped by the query; a junk value falls back to the default rather
      // than becoming NaN and returning nothing.
      ...(limit && Number.isFinite(Number(limit)) && Number(limit) > 0
        ? { limit: Number(limit) }
        : {}),
    });
  }
}
