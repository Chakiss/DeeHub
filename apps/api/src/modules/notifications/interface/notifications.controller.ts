import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireCapability } from '../../../common/guards/auth.guard';
import { ListNotificationsQuery } from '../application/list-notifications.query';

@ApiTags('notifications')
@Controller('properties/:propertyId/notifications')
export class NotificationsController {
  constructor(private readonly list: ListNotificationsQuery) {}

  /**
   * Read-only, and there is no endpoint to send one by hand.
   *
   * Messages exist because something happened to a booking. A "send this
   * again" button would let staff mail a guest whatever they liked from the
   * hotel's address, with no booking behind it and nothing in the audit trail
   * explaining why.
   */
  @Get()
  @RequireCapability('notification:read')
  @ApiOperation({ summary: 'What the hotel told guests and staff, newest first' })
  async getAll(
    @Param('propertyId') propertyId: string,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('reservationId') reservationId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.list.execute({
      propertyId,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(reservationId ? { reservationId } : {}),
      ...(cursor ? { cursor } : {}),
      // Clamped by the query; a junk value falls back to the default rather
      // than becoming NaN and returning nothing.
      ...(limit && Number.isFinite(Number(limit)) && Number(limit) > 0
        ? { limit: Number(limit) }
        : {}),
    });
  }
}
