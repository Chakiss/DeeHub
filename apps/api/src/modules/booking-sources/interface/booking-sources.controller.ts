import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { DATABASE, type Database } from '../../../database/database.module';
import { ManageBookingSourcesUseCase } from '../application/manage-booking-sources.usecase';
import {
  BOOKING_SOURCE_KINDS,
  BOOKING_SOURCE_REPOSITORY,
  type BookingSourceRecord,
  type BookingSourceRepository,
} from '../domain/booking-source.repository';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(BOOKING_SOURCE_KINDS),
  })
  .strict();

// No kind: every booking that named this source recorded its category from it.
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

type CreateBody = z.infer<typeof createSchema>;
type UpdateBody = z.infer<typeof updateSchema>;

/**
 * Where bookings come from, per property. Commercial setup rather than
 * front-desk work — the same hands that configure channels and rate plans —
 * so writes ride on `channel:update`, which a property manager holds and a
 * receptionist does not. Reading the list is part of taking a booking and
 * rides on `property:read`, which everyone who can see the property has.
 */
@ApiTags('booking-sources')
@Controller('properties/:propertyId/booking-sources')
export class BookingSourcesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(BOOKING_SOURCE_REPOSITORY) private readonly repo: BookingSourceRepository,
    private readonly manage: ManageBookingSourcesUseCase,
  ) {}

  @Get()
  @RequireCapability('property:read')
  @ApiOperation({ summary: 'Booking sources: OTAs and agents this property takes bookings from' })
  async list(@Param('propertyId') propertyId: string) {
    const rows = await this.repo.list(this.db, propertyId);
    return { items: rows.map(present) };
  }

  @Post()
  @RequireCapability('channel:update')
  @ApiOperation({ summary: 'Add a booking source' })
  async create(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(createSchema)) body: CreateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(await this.manage.create({ propertyId, ...body }, actorFrom(request)));
  }

  @Post('defaults')
  @RequireCapability('channel:update')
  @ApiOperation({ summary: 'Add the usual OTAs that are not yet listed' })
  async addDefaults(@Param('propertyId') propertyId: string, @Req() request: AuthenticatedRequest) {
    const rows = await this.manage.addDefaults(propertyId, actorFrom(request));
    return { items: rows.map(present) };
  }

  // No DELETE: reservations point at these. isActive: false retires one and
  // keeps every booking that named it reportable.
  @Patch(':sourceId')
  @RequireCapability('channel:update')
  @ApiOperation({ summary: 'Rename a booking source, or retire it' })
  async update(
    @Param('propertyId') propertyId: string,
    @Param('sourceId') sourceId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.manage.update({ propertyId, sourceId, fields: body }, actorFrom(request)),
    );
  }
}

function present(source: BookingSourceRecord) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    channelType: source.channelType,
    isActive: source.isActive,
  };
}
