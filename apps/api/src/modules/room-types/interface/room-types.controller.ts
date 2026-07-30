import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import type { AuditActor } from '../../../common/audit/audit.service';
import { ListRoomTypesQuery } from '../application/list-room-types.query';
import { CreateRoomTypeUseCase } from '../application/create-room-type.usecase';
import { UpdateRoomTypeUseCase } from '../application/update-room-type.usecase';
import type { RoomTypeRecord } from '../domain/room-type.repository';

/**
 * Codes end up in OTA mappings and CSV imports, so they are restricted to
 * characters that survive both: letters, digits, hyphen and underscore.
 */
const code = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphen or underscore');

const occupancy = z.number().int().min(1).max(30);

const createSchema = z
  .object({
    code,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    standardOccupancy: occupancy.default(2),
    maxOccupancy: occupancy.default(2),
    maxAdults: occupancy.default(2),
    maxChildren: z.number().int().min(0).max(30).default(0),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    standardOccupancy: occupancy.optional(),
    maxOccupancy: occupancy.optional(),
    maxAdults: occupancy.optional(),
    maxChildren: z.number().int().min(0).max(30).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

type CreateBody = z.infer<typeof createSchema>;
type UpdateBody = z.infer<typeof updateSchema>;

@ApiTags('room-types')
@Controller('properties/:propertyId/room-types')
export class RoomTypesController {
  constructor(
    private readonly list: ListRoomTypesQuery,
    private readonly create: CreateRoomTypeUseCase,
    private readonly update: UpdateRoomTypeUseCase,
  ) {}

  @Get()
  @RequireCapability('roomtype:read')
  @ApiOperation({ summary: 'Room types at a property, in display order' })
  async getAll(@Param('propertyId') propertyId: string) {
    const rows = await this.list.execute(propertyId);
    return { items: rows.map((row) => present(row)) };
  }

  @Post()
  @RequireCapability('roomtype:create')
  @ApiOperation({ summary: 'Create a room type' })
  async createOne(
    @Param('propertyId') propertyId: string,
    // Pipe on @Body, not @UsePipes: the latter also runs against @Param and
    // would reject the propertyId against this schema.
    @Body(new ZodValidationPipe(createSchema)) body: CreateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(await this.create.execute({ propertyId, ...body }, actorOf(request)));
  }

  // No DELETE. Inventory, rates, reservations and channel mappings reference a
  // room type with onDelete: restrict, so removing one a hotel has sold would
  // erase what those bookings were for. isActive: false stops the sale and
  // keeps the history intact.
  @Patch(':roomTypeId')
  @RequireCapability('roomtype:update')
  @ApiOperation({ summary: 'Update a room type, or deactivate it with isActive: false' })
  async updateOne(
    @Param('propertyId') propertyId: string,
    @Param('roomTypeId') roomTypeId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.update.execute({ propertyId, roomTypeId, fields: body }, actorOf(request)),
    );
  }
}

/** Explicit shape: never serialise the row, or a column added later leaks. */
function present(row: RoomTypeRecord) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    standardOccupancy: row.standardOccupancy,
    maxOccupancy: row.maxOccupancy,
    maxAdults: row.maxAdults,
    maxChildren: row.maxChildren,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

function actorOf(request: AuthenticatedRequest): AuditActor {
  const principal = request.principal;
  return {
    type: 'USER',
    id: principal?.id ?? null,
    label: principal?.email ?? 'unknown',
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
